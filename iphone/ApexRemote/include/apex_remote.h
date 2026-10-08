#ifndef APEX_REMOTE_H
#define APEX_REMOTE_H

#include <stdbool.h>
#include <stdint.h>

/* The C ABI of crates/iroh-mobile (static library libapex_remote.a).
 * Every char* returned here is JSON, {"ok":...} or {"error":"..."}, and must
 * be passed to apex_remote_string_free exactly once. */

/* Called on a Rust thread with one event as JSON. The string is valid only
 * for the duration of the call. */
typedef void (*apex_remote_event_cb)(void *ctx, const char *event_json);

/* Registers the event callback. False if one is already registered. */
bool apex_remote_init(apex_remote_event_cb cb, void *ctx);

/* The endpoint ID for a 32-byte secret key: {"ok":"<hex id>"}. */
char *apex_remote_endpoint_id(const uint8_t *key32);

/* Closes everything and binds for mode "automatic" or "direct" with this key.
 * Blocks; call off the main thread. {"ok":"<endpoint id>"}. */
char *apex_remote_set_mode(const uint8_t *key32, const char *mode);

/* {"op":"connect"|"send"|"close"|"pair"|"pairCancel", ...}. Never waits on
 * the network. */
char *apex_remote_call(const char *json);

/* Closes everything and waits for every task; no event arrives after it
 * returns. Blocks; call off the main thread. */
void apex_remote_shutdown(void);

/* Frees a string returned by this library. NULL is fine. */
void apex_remote_string_free(char *s);

#endif
