import unittest
from scraper import community_url, parse_community


class ScraperTests(unittest.TestCase):
    def test_detail_extraction(self):
        html = """<main><h1>Bellhaven Healthcare Centre of Ashland</h1>
        <dl class="detail"><dt>Address</dt><dd>1631 Claremont Ave<br>Ashland, OH 44805</dd>
        <dt>Care Offerings</dt><dd><span class="badge">Short-Term Rehabilitation &amp; Nursing</span></dd>
        <dt>Administrator</dt><dd>Carla Okafor</dd>
        <dt>Phone</dt><dd>(517) 314-5115</dd></dl></main>"""
        row = parse_community(html, "https://example.com/communities/ashland")
        self.assertEqual(row.address, "1631 Claremont Ave")
        self.assertEqual((row.city, row.state, row.zip), ("Ashland", "OH", "44805"))
        self.assertEqual(row.care_offerings, "Short-Term Rehabilitation & Nursing")
        self.assertEqual(row.name, "Bellhaven Healthcare Centre of Ashland")

    def test_multiple_offerings(self):
        html = """<h1>Sample</h1><dl><dt>Address</dt>
        <dd>11 Oak St<br>Springfield, IL 62704</dd><dt>Care Offerings</dt><dd>
        <span class="badge">Assisted Living</span><span class="badge">Memory Support</span>
        </dd></dl>"""
        row = parse_community(html, "https://example.com/communities/sample")
        self.assertEqual(row.care_offerings, "Assisted Living | Memory Support")

    def test_pagination_and_external_link_filter(self):
        base = "https://example.com"
        self.assertEqual(community_url("/communities?page=2", base, base), base + "/communities?page=2")
        self.assertEqual(community_url("/communities/abc#details", base, base), base + "/communities/abc")
        self.assertIsNone(community_url("https://other.com/communities/abc", base, base))
        self.assertIsNone(community_url("/crm/accounts/123", base, base))

    def test_missing_required_field(self):
        with self.assertRaises(ValueError):
            parse_community("<h1>Only a name</h1>", "https://example.com/communities/a")


if __name__ == "__main__":
    unittest.main()
