"""From a separate device on the tablet hotspot: verify HTTP and UDP roundtrips.
Usage: python network_probe.py TABLET_ROUTER_IP TOKEN
Optional: --mdns discovers _diplay-lab._tcp via zeroconf if installed.
"""
import argparse
import socket
import time
import urllib.request

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('host')
    parser.add_argument('token')
    parser.add_argument('--mdns', action='store_true')
    args = parser.parse_args()
    socket.inet_pton(socket.AF_INET, args.host)
    if len(args.token) != 16 or any(c not in '0123456789abcdef' for c in args.token.lower()):
        parser.error('token must be the 16 hexadecimal characters shown by the app')
    url = f'http://{args.host}:8787/{args.token}'
    # Ignore system proxies; this test is specifically a local path.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    started = time.monotonic()
    with opener.open(url, timeout=5) as response:
        body = response.read(16384).decode('utf-8')
        if response.status != 200 or '网络双向通信成功' not in body:
            raise RuntimeError('Unexpected HTTP response')
    print(f'HTTP PASS {(time.monotonic()-started)*1000:.1f} ms')
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
        client.settimeout(5)
        payload = f'{args.token}:roundtrip:{time.monotonic_ns()}'.encode('ascii')
        started = time.monotonic()
        client.sendto(payload, (args.host, 8788))
        echoed, address = client.recvfrom(1200)
        if echoed != payload or address != (args.host, 8788):
            raise RuntimeError('Unexpected UDP echo')
        print(f'UDP PASS {(time.monotonic()-started)*1000:.1f} ms')
    if args.mdns:
        # Optional companion dependency; app has no third-party dependency.
        from zeroconf import Zeroconf, ServiceBrowser
        found = []
        class Listener:
            def add_service(self, zc, service_type, name):
                info = zc.get_service_info(service_type, name, timeout=2000)
                if info and args.host in info.parsed_addresses() and info.port == 8787:
                    found.append(name)
            def update_service(self, zc, service_type, name):
                self.add_service(zc, service_type, name)
            def remove_service(self, zc, service_type, name):
                pass
        with Zeroconf() as zc:
            browser = ServiceBrowser(zc, '_diplay-lab._tcp.local.', Listener())
            deadline = time.monotonic()+8
            while not found and time.monotonic() < deadline:
                time.sleep(0.1)
            browser.cancel()
        if not found:
            raise RuntimeError('mDNS did not discover the tablet endpoint')
        print('mDNS PASS: endpoint discovered')

if __name__ == '__main__':
    main()
