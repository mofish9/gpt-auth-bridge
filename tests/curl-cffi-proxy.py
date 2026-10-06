"""Check that curl-cffi uses remote DNS for SOCKS5 proxy requests."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'login-service' / 'scripts'))
from curl_cffi_session import curl_proxy_url


class CurlProxyUrlTest(unittest.TestCase):
    def test_socks5_uses_remote_dns_without_changing_credentials(self):
        self.assertEqual(
            curl_proxy_url('socks5://user:p%40ss@proxy.example:35030'),
            'socks5h://user:p%40ss@proxy.example:35030',
        )

    def test_other_routes_remain_unchanged(self):
        for url in ('socks5h://user:pass@proxy.example:1080',
                    'http://user:pass@proxy.example:8080', ''):
            with self.subTest(url=url):
                self.assertEqual(curl_proxy_url(url), url)


if __name__ == '__main__':
    unittest.main()
