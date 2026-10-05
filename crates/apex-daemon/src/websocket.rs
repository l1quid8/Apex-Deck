//! The WebSocket transport: one text message is one frame.

use std::sync::Arc;

use futures::future::ready;
use futures::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Error, Message};

use crate::protocol::{self, Daemon, Trust, MAX_FRAME};

/// Serve one WebSocket client. `hello` must carry the daemon's token.
pub async fn serve(daemon: Arc<Daemon>, stream: TcpStream) {
    let config = WebSocketConfig::default().max_message_size(Some(MAX_FRAME)).max_frame_size(Some(MAX_FRAME));
    let Ok(socket) = tokio_tungstenite::accept_async_with_config(stream, Some(config)).await else { return };
    let (sink, stream) = socket.split();
    let input = stream.filter_map(|message| {
        ready(match message {
            Ok(Message::Text(text)) => Some(Ok(text.as_str().to_string())),
            Ok(Message::Binary(_)) => Some(Err("binary messages are not part of the protocol".to_string())),
            // Pings are answered by the library; a close ends the stream.
            Ok(_) => None,
            Err(e) => Some(Err(e.to_string())),
        })
    });
    let output = sink.with(|text: String| ready(Ok::<_, Error>(Message::text(text))));
    protocol::serve(daemon, Trust::Token, Box::pin(input), Box::pin(output)).await;
}
