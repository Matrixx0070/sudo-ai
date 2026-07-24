#!/usr/bin/env python3
"""
Mint fresh gemini.google.com session cookies from a ONE-TIME human-seeded token,
with no browser. This does NOT defeat any anti-bot challenge: the human performs the
real interactive sign-in once (where Google's BotGuard runs legitimately in a real
browser) and drops the resulting `oauth_token` here; from then on this runs headlessly.

Flow (port of simon-weber/gpsoauth over the curl_cffi chrome-JA3 transport, which the
grok lane already uses for Google-grade endpoints):
  seed oauth_token --exchange_token--> master token --perform_oauth(weblogin)--> an Auth
  URL --GET (follow redirects)--> Set-Cookie jar containing __Secure-1PSID etc.

Note: an oauth_token is exchanged via exchange_token (Token passed directly, ACCESS_TOKEN=1)
— NOT master_login (which RSA-encrypts a password and is length-limited).

Usage:  python3 gpsoauth_mint.py <seed_file_0600> <out_cookies_file_0600>
  seed_file JSON: {"email": "...", "oauth_token": "..."}   (first run)
             or   {"email": "...", "master_token": "..."}   (reuse a durable master token)
  out JSON:       {"cookies": {name: val, ...}, "userAgent": "..."}   (0600)

Secrets are NEVER printed: stdout shows only cookie NAMES and boolean presence.
Tunable via env (the weblogin string is the one live-unknown to adjust on first real run):
  GPSOAUTH_SERVICE (default "weblogin:continue=https://gemini.google.com/")
  GPSOAUTH_APP     (default "com.google.android.googlequicksearchbox")
"""
import json
import os
import sys
import secrets

from curl_cffi import requests as creq

AUTH_URL = "https://android.clients.google.com/auth"
USER_AGENT_AUTH = "GoogleAuth/1.4"
# Chrome UA for the cookie jar the headless gemini client will replay.
BROWSER_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)
CLIENT_SIG = "38918a453d07199354f8b19af05ec6562ced5788"


def _auth_post(session, data: dict) -> dict:
    h = {
        "Accept-Encoding": "identity",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT_AUTH,
    }
    r = session.post(AUTH_URL, data=data, headers=h, impersonate="chrome", timeout=30)
    out = {}
    for line in r.text.split("\n"):
        if "=" in line:
            k, _, v = line.partition("=")
            out[k] = v
    out["_status"] = r.status_code
    return out


def _device_id() -> str:
    """Stable 16-hex androidId, persisted so re-mints don't look like a new device each time.
    Anchored next to the seed file (which lives in gitignored data/), never in tracked dirs."""
    path = os.path.join(os.path.dirname(os.path.abspath(sys.argv[1])), ".gemini-gpsoauth-device")
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        aid = secrets.token_hex(8)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(aid)
        return aid


def exchange_token(session, email: str, oauth_token: str, android_id: str) -> str:
    """Exchange a web oauth_token for a durable master token (Token passed directly, no RSA)."""
    data = {
        "accountType": "HOSTED_OR_GOOGLE",
        "Email": email,
        "has_permission": 1,
        "add_account": 1,
        "ACCESS_TOKEN": 1,
        "Token": oauth_token,
        "service": "ac2dm",
        "source": "android",
        "androidId": android_id,
        "device_country": "us",
        "operatorCountry": "us",
        "lang": "en",
        "sdk_version": 17,
        "google_play_services_version": 240913000,
        "client_sig": CLIENT_SIG,
        "callerSig": CLIENT_SIG,
        "droidguard_results": "dummy123",
    }
    res = _auth_post(session, data)
    token = res.get("Token")
    if not token:
        raise SystemExit(
            f"exchange_token failed (status {res.get('_status')}): {res.get('Error', 'no Token returned')}. "
            "If Error=BadAuthentication/NeedsBrowser, the oauth_token seed is stale/invalid — re-seed it."
        )
    return token


def perform_oauth_weblogin(session, email: str, master_token: str, android_id: str) -> str:
    service = os.environ.get("GPSOAUTH_SERVICE", "weblogin:continue=https://gemini.google.com/")
    app = os.environ.get("GPSOAUTH_APP", "com.google.android.googlequicksearchbox")
    data = {
        "accountType": "HOSTED_OR_GOOGLE",
        "Email": email,
        "has_permission": 1,
        "EncryptedPasswd": master_token,
        "service": service,
        "source": "android",
        "androidId": android_id,
        "app": app,
        "client_sig": CLIENT_SIG,
        "device_country": "us",
        "operatorCountry": "us",
        "lang": "en",
        "sdk_version": 17,
        "google_play_services_version": 240913000,
    }
    res = _auth_post(session, data)
    auth = res.get("Auth")
    if not auth:
        raise SystemExit(
            f"perform_oauth(weblogin) failed (status {res.get('_status')}): "
            f"{res.get('Error', 'no Auth returned')}. Try a different GPSOAUTH_SERVICE/APP."
        )
    return auth


def mint_cookies(session, auth: str) -> dict:
    """The weblogin Auth is a URL (a MergeSession-style link); GET it and harvest Set-Cookie."""
    if auth.startswith("http"):
        session.get(auth, impersonate="chrome", allow_redirects=True, timeout=30)
    else:
        # Fallback: treat Auth as an uberauth for an explicit MergeSession.
        session.get(
            "https://accounts.google.com/MergeSession",
            params={"uberauth": auth, "continue": "https://gemini.google.com/", "source": "ChromiumBrowser"},
            impersonate="chrome",
            allow_redirects=True,
            timeout=30,
        )
    jar = {}
    for c in session.cookies.jar:
        if "google.com" in (c.domain or ""):
            jar[c.name] = c.value
    return jar


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: gpsoauth_mint.py <seed_file_0600> <out_cookies_file_0600>")
    seed_path, out_path = sys.argv[1], sys.argv[2]
    with open(seed_path) as f:
        seed = json.load(f)
    email = seed["email"]
    android_id = seed.get("android_id") or _device_id()

    session = creq.Session()
    master_token = seed.get("master_token")
    if not master_token:
        master_token = exchange_token(session, email, seed["oauth_token"], android_id)
        # The oauth_token is single-use; persist the DURABLE master token back to the seed so
        # every future re-auth is browserless with no sign-in (until password change / revoke).
        fd = os.open(seed_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump({"email": email, "master_token": master_token, "android_id": android_id}, f)
        print("exchange_token OK — durable master token persisted to seed (browserless from now on).")

    auth = perform_oauth_weblogin(session, email, master_token, android_id)
    cookies = mint_cookies(session, auth)

    names = sorted(cookies.keys())
    have_psid = "__Secure-1PSID" in cookies
    print(f"minted {len(names)} google cookies: {', '.join(names) or '(none)'}")
    print(f"__Secure-1PSID present: {have_psid}")
    if not have_psid:
        raise SystemExit("no __Secure-1PSID minted — weblogin service/app likely needs tuning (GPSOAUTH_SERVICE).")

    fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"cookies": cookies, "userAgent": BROWSER_UA}, f)
    print(f"wrote 0600 cookie file: {out_path}")


if __name__ == "__main__":
    main()
