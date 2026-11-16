//! The daemon's log lines, through `tracing`.
//!
//! Every line keeps the shape stderr has always had, so the desktop app (which
//! shows the daemon's last line when it fails to start), the LaunchAgent log
//! and `log_time.rs` (which stamps lines in that log) go on working:
//!
//! ```text
//! apex-daemon: listening on /…/daemon.sock (network port: None) socket=/…/daemon.sock
//! [apex-deck] Renewed Deck's Claude sign-in. provider=claude
//! ```
//!
//! The message comes first, unchanged. Fields follow as ` key=value`: the
//! event's own, then those of the spans it runs in, so a line written while a
//! command runs ends in `cmd=room_post room=<id>`. A message that starts with
//! `[` already names its source and gets no `apex-daemon: ` prefix.
//!
//! `APEX_DECK_LOG` picks what is written (a `tracing` filter, default `info`),
//! e.g. `APEX_DECK_LOG=debug` or `APEX_DECK_LOG=apex_daemon::remote=trace`.
use std::fmt;

use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::{FmtContext, FormatEvent, FormatFields, FormattedFields};
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::EnvFilter;

/// What a message with no `[source]` of its own is prefixed with.
pub const PREFIX: &str = "apex-daemon: ";

/// Install the subscriber once. A second call (tests that run several entry
/// points in one process) keeps the first.
pub fn init() {
    let filter = EnvFilter::try_from_env("APEX_DECK_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).with_ansi(false).event_format(LineFormat).try_init();
}

/// `apex-daemon: <message> key=value…`, one line per event.
pub struct LineFormat;

impl<S, N> FormatEvent<S, N> for LineFormat
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(&self, ctx: &FmtContext<'_, S, N>, mut writer: Writer<'_>, event: &Event<'_>) -> fmt::Result {
        let mut fields = Fields::default();
        event.record(&mut fields);
        let span_fields: Vec<String> = ctx
            .event_scope()
            .map(|scope| {
                scope.from_root().filter_map(|span| span.extensions().get::<FormattedFields<N>>().filter(|f| !f.is_empty()).map(|f| f.to_string())).collect()
            })
            .unwrap_or_default();
        write!(writer, "{}", line(&fields.message, &fields.rest, &span_fields))?;
        writeln!(writer)
    }
}

/// The line for `message` with the event's fields and then its spans' fields.
pub fn line(message: &str, fields: &[(String, String)], span_fields: &[String]) -> String {
    let mut out = String::new();
    if !message.starts_with('[') { out.push_str(PREFIX); }
    out.push_str(message);
    for (name, value) in fields { out.push(' '); out.push_str(name); out.push('='); out.push_str(value); }
    for span in span_fields { out.push(' '); out.push_str(span); }
    out
}

#[derive(Default)]
struct Fields {
    message: String,
    rest: Vec<(String, String)>,
}

impl Visit for Fields {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if field.name() == "message" { self.message = format!("{value:?}"); } else { self.rest.push((field.name().to_string(), format!("{value:?}"))); }
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" { self.message = value.to_string(); } else { self.rest.push((field.name().to_string(), value.to_string())); }
    }
    fn record_i64(&mut self, field: &Field, value: i64) { self.rest.push((field.name().to_string(), value.to_string())); }
    fn record_u64(&mut self, field: &Field, value: u64) { self.rest.push((field.name().to_string(), value.to_string())); }
    fn record_bool(&mut self, field: &Field, value: bool) { self.rest.push((field.name().to_string(), value.to_string())); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_message_keeps_the_old_prefix_and_fields_follow_it() {
        assert_eq!(line("listening on /x", &[("socket".into(), "/x".into())], &[]), "apex-daemon: listening on /x socket=/x");
        assert_eq!(line("stopping", &[], &[]), "apex-daemon: stopping");
    }

    #[test]
    fn a_message_that_names_its_source_is_left_alone_and_span_fields_come_last() {
        assert_eq!(line("[apex-deck] Renewed", &[("provider".into(), "claude".into())], &["cmd=room_post room=r1".into()]), "[apex-deck] Renewed provider=claude cmd=room_post room=r1");
    }

    #[test]
    fn the_subscriber_writes_the_same_shape_through_tracing() {
        use std::io::Write;
        use std::sync::{Arc, Mutex};
        #[derive(Clone, Default)]
        struct Sink(Arc<Mutex<Vec<u8>>>);
        impl Write for Sink {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> { self.0.lock().unwrap().extend_from_slice(buf); Ok(buf.len()) }
            fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
        }
        let sink = Sink::default();
        let writer = sink.clone();
        let subscriber = tracing_subscriber::fmt().with_writer(move || writer.clone()).with_ansi(false).event_format(LineFormat).finish();
        tracing::subscriber::with_default(subscriber, || {
            let span = tracing::info_span!("cmd", cmd = "room_post", room = "r1");
            let _entered = span.enter();
            tracing::info!(bytes = 12u64, "a frame of {} bytes", 12);
            tracing::warn!("[model-gateway] upstream HTTP 502");
        });
        let text = String::from_utf8(sink.0.lock().unwrap().clone()).unwrap();
        assert_eq!(text, "apex-daemon: a frame of 12 bytes bytes=12 cmd=\"room_post\" room=\"r1\"\n[model-gateway] upstream HTTP 502 cmd=\"room_post\" room=\"r1\"\n");
    }
}
