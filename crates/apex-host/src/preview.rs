//! The Preview pane's look before it loads a page: is anything answering at
//! the address, and does the site allow being shown inside another app.
//! See docs/superpowers/specs/2026-10-04-preview-and-artifacts.md, 1.4.

use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Probe {
    /// Something answered, and it may be shown in a frame.
    Ok,
    /// The site asks browsers not to show it inside other apps.
    Refused,
    /// Nothing answered.
    Unreachable { reason: String },
}

/// Whether a response's headers forbid showing it in a frame owned by another
/// site: `X-Frame-Options` of DENY, SAMEORIGIN or ALLOW-FROM (values browsers
/// don't know are ignored, as browsers do), or a `frame-ancestors` directive
/// that doesn't list `*`.
pub fn refuses_framing(x_frame_options: &[&str], policies: &[&str]) -> bool {
    let by_header = x_frame_options.iter().flat_map(|value| value.split(',')).any(|value| {
        let value = value.trim().to_ascii_lowercase();
        value == "deny" || value == "sameorigin" || value.starts_with("allow-from")
    });
    let by_policy = policies.iter().flat_map(|policy| policy.split(';')).any(|directive| {
        let mut parts = directive.split_whitespace();
        parts.next().is_some_and(|name| name.eq_ignore_ascii_case("frame-ancestors")) && !parts.any(|source| source == "*")
    });
    by_header || by_policy
}

/// A client for looking: 4 s at most, up to 5 redirects, never through a proxy.
pub fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::limited(5))
        .no_proxy()
        .build()
        .expect("the preview client has no settings that can fail")
}

pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(build_client)
}

/// Request the address and judge the answer by its headers. The body is never
/// read. HTTP error statuses still count as answering.
pub async fn probe(client: &reqwest::Client, address: &str) -> Result<Probe, String> {
    let url = reqwest::Url::parse(address).map_err(|_| "That isn't a web address.".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Only web addresses can be previewed.".into());
    }
    match client.get(url).send().await {
        Ok(response) => {
            let headers = response.headers();
            let frame: Vec<&str> = headers.get_all("x-frame-options").iter().filter_map(|v| v.to_str().ok()).collect();
            let policy: Vec<&str> = headers.get_all("content-security-policy").iter().filter_map(|v| v.to_str().ok()).collect();
            Ok(if refuses_framing(&frame, &policy) { Probe::Refused } else { Probe::Ok })
        }
        Err(error) => Ok(Probe::Unreachable {
            reason: if error.is_timeout() { "It took too long to answer.".into() } else { "Nothing is answering there.".into() },
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_rules_follow_the_headers() {
        assert!(!refuses_framing(&[], &[]));
        assert!(refuses_framing(&["DENY"], &[]));
        assert!(refuses_framing(&["sameorigin"], &[]));
        assert!(refuses_framing(&["ALLOW-FROM https://example.com"], &[]));
        assert!(refuses_framing(&["SAMEORIGIN, SAMEORIGIN"], &[]));
        assert!(!refuses_framing(&["ALLOWALL"], &[]), "browsers ignore values they don't know");
        assert!(refuses_framing(&[], &["default-src 'self'; frame-ancestors 'self'"]));
        assert!(refuses_framing(&[], &["frame-ancestors 'none'"]));
        assert!(!refuses_framing(&[], &["frame-ancestors *"]));
        assert!(!refuses_framing(&[], &["default-src 'self'"]));
        assert!(refuses_framing(&[], &["default-src *", "frame-ancestors https://a.example"]));
    }

    /// Answer one request with a fixed response, from a port picked by the system.
    fn serve_once(response: &'static str) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}/", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0u8; 2048];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(response.as_bytes());
            }
        });
        address
    }

    #[tokio::test]
    async fn a_page_that_forbids_frames_is_refused_and_one_that_allows_them_is_ok() {
        let client = build_client();
        let refused = serve_once("HTTP/1.1 200 OK\r\nX-Frame-Options: DENY\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        assert_eq!(probe(&client, &refused).await.unwrap(), Probe::Refused);
        let missing = serve_once("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        assert_eq!(probe(&client, &missing).await.unwrap(), Probe::Ok);
    }

    #[tokio::test]
    async fn nothing_listening_is_unreachable() {
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let result = probe(&build_client(), &format!("http://127.0.0.1:{port}/")).await.unwrap();
        assert!(matches!(result, Probe::Unreachable { .. }), "{result:?}");
    }

    #[tokio::test]
    async fn only_web_addresses_are_looked_at() {
        let client = build_client();
        assert!(probe(&client, "file:///etc/passwd").await.is_err());
        assert!(probe(&client, "not an address").await.is_err());
    }

    #[test]
    fn probes_serialize_the_way_the_frontend_reads_them() {
        assert_eq!(serde_json::to_value(Probe::Ok).unwrap(), serde_json::json!({"kind":"ok"}));
        assert_eq!(serde_json::to_value(Probe::Unreachable { reason: "x".into() }).unwrap(), serde_json::json!({"kind":"unreachable","reason":"x"}));
    }
}
