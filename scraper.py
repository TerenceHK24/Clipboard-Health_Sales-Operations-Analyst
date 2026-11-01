"""Scrape all discoverable Bellhaven community details to CSV."""
from __future__ import annotations

import argparse
import csv
import logging
import re
import time
from collections import deque
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE_URL = "https://analyst-assessment-production.up.railway.app"
LOCATION_RE = re.compile(r"^/communities/[^/]+/?$")
CITY_RE = re.compile(r"^(?P<city>.+?),\s*(?P<state>[A-Za-z]{2})\s+(?P<zip>\d{5}(?:-\d{4})?)$")
COUNT_RE = re.compile(r"\b([\d,]+)\s+communities\s+listed\b", re.I)
LOG = logging.getLogger(__name__)


@dataclass(frozen=True)
class Community:
    name: str
    address: str
    city: str
    state: str
    zip: str
    care_offerings: str
    administrator: str
    phone: str
    source_url: str


def make_session() -> requests.Session:
    session = requests.Session()
    retries = Retry(
        total=4, backoff_factor=0.6,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET"}),
        respect_retry_after_header=True,
    )
    session.mount("https://", HTTPAdapter(max_retries=retries))
    session.mount("http://", HTTPAdapter(max_retries=retries))
    session.headers["User-Agent"] = "BellhavenCommunityResearch/1.0"
    return session


def community_url(href: str, page_url: str, base_url: str) -> str | None:
    parsed = urlsplit(urljoin(page_url, href))
    root = urlsplit(base_url)
    if (parsed.scheme, parsed.netloc) != (root.scheme, root.netloc):
        return None
    path = parsed.path.rstrip("/") or "/"
    if path != "/communities" and not LOCATION_RE.fullmatch(path):
        return None
    query = parsed.query if path == "/communities" else ""
    return urlunsplit((parsed.scheme, parsed.netloc, path, query, ""))


def discover(session: requests.Session, base_url: str, delay: float) -> list[str]:
    root = base_url.rstrip("/")
    queue = deque([root + "/communities", root + "/"])
    visited, locations, advertised = set(), set(), set()
    while queue:
        url = queue.popleft()
        if url in visited:
            continue
        visited.add(url)
        response = session.get(url, timeout=25)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        if urlsplit(url).path == "/communities":
            count = COUNT_RE.search(soup.get_text(" ", strip=True))
            if count:
                advertised.add(int(count.group(1).replace(",", "")))
        for anchor in soup.select("a[href]"):
            link = community_url(anchor["href"], response.url, root)
            if not link:
                continue
            if LOCATION_RE.fullmatch(urlsplit(link).path):
                locations.add(link)
            elif link not in visited:
                queue.append(link)
        time.sleep(delay)
    if not locations:
        raise RuntimeError("No community detail links found.")
    if advertised and len(locations) < max(advertised):
        raise RuntimeError(
            f"Only {len(locations)} unique links found versus "
            f"{max(advertised)} communities advertised by the directory."
        )
    return sorted(locations)


def parse_community(html: str, url: str) -> Community:
    soup = BeautifulSoup(html, "html.parser")
    heading = soup.select_one("main h1") or soup.select_one("h1")
    if heading is None:
        raise ValueError(f"Missing community heading: {url}")
    details = {}
    for dl in soup.select("dl"):
        label = None
        for item in dl.find_all(["dt", "dd"], recursive=False):
            if item.name == "dt":
                label = re.sub(r"[^a-z0-9]+", " ", item.get_text(" ", strip=True).lower()).strip()
            elif label:
                details[label] = item
                label = None
    address_field = details.get("address")
    if address_field is None:
        raise ValueError(f"Missing address: {url}")
    lines = list(address_field.stripped_strings)
    if len(lines) < 2:
        raise ValueError(f"Incomplete address: {url}")
    match = CITY_RE.fullmatch(lines[-1].strip())
    if not match:
        raise ValueError(f"Could not parse city/state/ZIP: {lines[-1]!r} ({url})")
    care_field = details.get("care offerings") or details.get("care offering")
    if care_field is None:
        raise ValueError(f"Missing care offerings: {url}")
    offerings = [s.get_text(" ", strip=True) for s in care_field.select(".badge")]
    if not offerings:
        offerings = list(care_field.stripped_strings)
    if not offerings:
        raise ValueError(f"Empty care offerings: {url}")

    def optional(label: str) -> str:
        node = details.get(label)
        return node.get_text(" ", strip=True) if node else ""

    return Community(
        name=heading.get_text(" ", strip=True),
        address=", ".join(x.strip() for x in lines[:-1]),
        city=match.group("city").strip(),
        state=match.group("state").upper(),
        zip=match.group("zip"),
        care_offerings=" | ".join(dict.fromkeys(offerings)),
        administrator=optional("administrator"),
        phone=optional("phone"),
        source_url=url,
    )


def scrape(base_url: str, delay: float) -> list[Community]:
    with make_session() as session:
        urls = discover(session, base_url, delay)
        results = []
        for number, url in enumerate(urls, start=1):
            response = session.get(url, timeout=25)
            response.raise_for_status()
            results.append(parse_community(response.text, response.url))
            LOG.info("[%d/%d] %s", number, len(urls), results[-1].name)
            time.sleep(delay)
    return sorted(results, key=lambda row: (row.name.casefold(), row.source_url))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=BASE_URL)
    parser.add_argument("--output", type=Path, default=Path("bellhaven_locations.csv"))
    parser.add_argument("--delay", type=float, default=0.2)
    args = parser.parse_args()
    if args.delay < 0:
        parser.error("--delay must be nonnegative")
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    results = scrape(args.base_url, args.delay)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=list(Community.__dataclass_fields__))
        writer.writeheader()
        writer.writerows(asdict(row) for row in results)
    print(f"Saved {len(results)} locations to {args.output}")


if __name__ == "__main__":
    main()
