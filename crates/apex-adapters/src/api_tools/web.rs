//! Reading a web page: fetched, and turned into plain text when it is HTML.

use std::sync::OnceLock;
use std::time::Duration;

use futures::StreamExt;
use regex::Regex;

/// Largest body read from a page.
const BODY_MAX: usize = 5 * 1024 * 1024;

/// Fetch `url` and give back what it says as text, with the address it
/// ended at, its status and its type.
pub(crate) async fn fetch(url: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|e| format!("That isn't a valid address: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only http and https addresses can be fetched.".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent(concat!("ApexDeck/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("Couldn't set up the request: {e}"))?;
    let response = client.get(parsed).send().await.map_err(|e| format!("Couldn't fetch {url}: {e}"))?;
    let status = response.status();
    let final_url = response.url().to_string();
    let kind = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut body = Vec::new();
    let mut cut = false;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("The page stopped loading: {e}"))?;
        let room = BODY_MAX - body.len();
        if chunk.len() > room {
            body.extend_from_slice(&chunk[..room]);
            cut = true;
            break;
        }
        body.extend_from_slice(&chunk);
    }
    let textual = kind.is_empty()
        || kind.starts_with("text/")
        || ["json", "xml", "javascript", "yaml", "csv", "markdown"].iter().any(|t| kind.contains(t));
    let content = if !textual || body.contains(&0) {
        format!("(binary content, {} bytes, not shown)", body.len())
    } else {
        let raw = String::from_utf8_lossy(&body);
        if kind.contains("html") || (kind.is_empty() && raw.trim_start().starts_with('<')) {
            html_to_text(&raw)
        } else {
            raw.into_owned()
        }
    };
    let mut out = format!("URL: {final_url}\nStatus: {status}\nType: {}\n\n{content}", if kind.is_empty() { "unknown" } else { &kind });
    if cut {
        out.push_str("\n\n(the page was larger than 5 MB; only the start was read)");
    }
    Ok(out)
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid pattern"))
}

/// Readable text from HTML: scripts, styles and tags removed, block ends
/// turned into line breaks, entities decoded and blank runs collapsed.
pub(crate) fn html_to_text(html: &str) -> String {
    static HIDDEN: OnceLock<Regex> = OnceLock::new();
    static COMMENT: OnceLock<Regex> = OnceLock::new();
    static BREAK: OnceLock<Regex> = OnceLock::new();
    static TAG: OnceLock<Regex> = OnceLock::new();
    static ENTITY: OnceLock<Regex> = OnceLock::new();
    static SPACES: OnceLock<Regex> = OnceLock::new();
    static BLANKS: OnceLock<Regex> = OnceLock::new();
    let text = re(&HIDDEN, r"(?is)<(script|style|noscript|svg|template|head)\b.*?</(script|style|noscript|svg|template|head)\s*>").replace_all(html, " ");
    let text = re(&COMMENT, r"(?s)<!--.*?-->").replace_all(&text, " ");
    let text = re(&BREAK, r"(?i)<\s*(br|/p|/div|/li|/tr|/h[1-6]|/section|/article|/header|/footer|/table|/ul|/ol|/pre|/blockquote|hr)\b[^>]*>").replace_all(&text, "\n");
    let text = re(&TAG, r"(?s)<[^>]*>").replace_all(&text, "");
    let text = re(&ENTITY, r"&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);").replace_all(&text, |caps: &regex::Captures| {
        let name = &caps[1];
        let decoded = if let Some(hex) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
            u32::from_str_radix(hex, 16).ok().and_then(char::from_u32).map(String::from)
        } else if let Some(dec) = name.strip_prefix('#') {
            dec.parse::<u32>().ok().and_then(char::from_u32).map(String::from)
        } else {
            match name {
                "amp" => Some("&".into()),
                "lt" => Some("<".into()),
                "gt" => Some(">".into()),
                "quot" => Some("\"".into()),
                "apos" => Some("'".into()),
                "nbsp" => Some(" ".into()),
                "mdash" => Some("\u{2014}".into()),
                "ndash" => Some("\u{2013}".into()),
                "hellip" => Some("\u{2026}".into()),
                "copy" => Some("\u{a9}".into()),
                _ => None,
            }
        };
        decoded.unwrap_or_else(|| caps[0].to_string())
    });
    let text = re(&SPACES, r"[ \t\r\f\v]+").replace_all(&text, " ");
    let text: String = text.lines().map(str::trim).collect::<Vec<_>>().join("\n");
    re(&BLANKS, r"\n{3,}").replace_all(&text, "\n\n").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::html_to_text;

    #[test]
    fn html_becomes_readable_text() {
        let html = "<html><head><title>T</title><style>p{color:red}</style></head><body><h1>Hello &amp; welcome</h1><script>var x=1;</script><p>One<br>Two&nbsp;&#x41;&#66;</p><!-- note --><ul><li>a</li><li>b</li></ul></body></html>";
        assert_eq!(html_to_text(html), "Hello & welcome\nOne\nTwo AB\na\nb");
    }
}
