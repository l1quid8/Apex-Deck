#ifndef APEX_COMPUTER_ENGINE_H
#define APEX_COMPUTER_ENGINE_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* The callback runs synchronously on the dedicated native worker. A non-NULL
 * element is a borrowed AXUIElementRef checked immediately before mutation.
 * Return zero to revoke. The context must remain alive until call returns. */
typedef int32_t (*ApexEngineCheck)(void *context, const void *element);
void *apex_engine_create(void);
char *apex_engine_call(void *engine, const char *request_json, ApexEngineCheck check, void *context);
/* Drops content-bearing maps and retained objects on their owner thread. */
void apex_engine_reset(void *engine);
void apex_engine_free_string(char *value);
void apex_engine_destroy(void *engine);
#ifdef __cplusplus
}
#endif
#endif
