# Bellhaven Location Scraper

Dynamically discovers Bellhaven community pages and saves their detail fields in CSV. No location names, addresses, care types, or total counts are hard-coded.

## Installation and usage

```bash
python -m pip install -r requirements.txt
python scraper.py --output bellhaven_locations.csv
```

Optional flags: `--base-url` for an alternative host and `--delay 0.5` to slow requests.

## Discovery and extraction

- Begins at the paginated `/communities` directory and the homepage, following same-host links to community details.
- Traverses every linked directory page, deduplicates links, and compares discovered URLs to the published directory count.
- Parses each page by the labels in `<dl><dt>...</dt><dd>...</dd></dl>`, not by positional indexes.
- Separates multiline address into street address, city, state, ZIP; captures all care offering badges; captures optional administrator and phone.
- Exports UTF-8-with-BOM CSV suitable for Excel.

Output columns: `name,address,city,state,zip,care_offerings,administrator,phone,source_url`. Multiple care offerings are joined with ` | `.

## Tests

```bash
python -m unittest discover -s tests -v
```

## Notes

The directory displayed 34 communities across 3 pages when inspected, while the homepage mentioned 35. The scraper therefore also discovers community links from the homepage. Pages not linked from either starting point cannot be guaranteed. The scraper raises an exception on missing essential fields or an obvious shortfall against the directory count instead of silently exporting incomplete records.
