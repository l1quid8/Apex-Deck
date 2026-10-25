// Display-targeted simulator touch input. CoreSimulator and DTUHID are supplied
// by the selected Xcode; no app, accessibility, or desktop input is synthesized.
#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <xpc/xpc.h>
#import <mach/mach.h>
#import <math.h>
#import <stdatomic.h>

@interface NSObject (DeckSimulator)
+ (id)sharedServiceContextForDeveloperDir:(id)directory error:(NSError **)error;
- (id)defaultDeviceSetWithError:(NSError **)error;
- (NSArray *)availableDevices;
- (mach_port_t)lookup:(NSString *)service error:(NSError **)error;
@end

static const char *service = "com.apple.coredevice.feature.remote.hid.digitizer";
static BOOL sendPayload(xpc_connection_t connection, const char *type, xpc_object_t payload) {
    xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
    xpc_dictionary_set_string(message, "messageType", type);
    xpc_dictionary_set_bool(message, "isBarrier", false);
    xpc_dictionary_set_string(message, "featureIdentifier", service);
    xpc_dictionary_set_value(message, "payload", payload);
    dispatch_semaphore_t sent = dispatch_semaphore_create(0);
    xpc_connection_send_message(connection, message);
    xpc_connection_send_barrier(connection, ^{ dispatch_semaphore_signal(sent); });
    return dispatch_semaphore_wait(sent, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)) == 0;
}

static BOOL sendTouch(xpc_connection_t connection, uint64_t target, double x, double y, uint64_t phase) {
    xpc_object_t payload = xpc_dictionary_create(NULL, NULL, 0);
    xpc_object_t point = xpc_dictionary_create(NULL, NULL, 0);
    xpc_dictionary_set_double(point, "x", x);
    xpc_dictionary_set_double(point, "y", y);
    xpc_dictionary_set_value(payload, "pointOne", point);
    xpc_dictionary_set_uint64(payload, "eventType", phase);
    xpc_dictionary_set_uint64(payload, "edge", 0);
    xpc_dictionary_set_uint64(payload, "target", target);
    return sendPayload(connection, "IndigoDigitizerEvent", payload);
}

static BOOL sendKey(xpc_connection_t connection, uint64_t code, uint64_t state) {
    xpc_object_t payload = xpc_dictionary_create(NULL, NULL, 0);
    xpc_dictionary_set_uint64(payload, "usageCode", code);
    xpc_dictionary_set_uint64(payload, "state", state);
    return sendPayload(connection, "IndigoKeyboardButtonEvent", payload);
}

// US keyboard codes match the existing phone text contract (printable ASCII).
static uint64_t textKey(unsigned char c, BOOL *shift) {
    *shift = c >= 'A' && c <= 'Z';
    if (c >= 'a' && c <= 'z') return 4 + c - 'a';
    if (*shift) return 4 + c - 'A';
    const char *plain = "1234567890-=[]\\;'`,./";
    const char *upper = "!@#$%^&*()_+{}|:\"~<>?";
    const uint64_t codes[] = {30,31,32,33,34,35,36,37,38,39,45,46,47,48,49,51,52,53,54,55,56};
    const char *at = strchr(plain, c);
    if (at) return codes[at-plain];
    at = strchr(upper, c);
    if (at) { *shift=YES; return codes[at-upper]; }
    return c == ' ' ? 44 : 0;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        // directory, UDID, display ID, start ratio, end ratio, duration (ms),
        // or directory, UDID, "key", USB HID keycode.
        BOOL typing = argc == 4 && strcmp(argv[3], "type") == 0;
        BOOL keyboard = argc == 5 && strcmp(argv[3], "key") == 0;
        if (argc != 9 && !keyboard && !typing) { fprintf(stderr, "Invalid simulator input arguments.\n"); return 2; }
        double values[5] = {0};
        char *end = NULL;
        unsigned long key = 0, target = 0;
        NSData *text = nil;
        if (typing) {
            text = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
            if (text.length == 0 || text.length > 500) return 2;
            const unsigned char *bytes = text.bytes;
            for (NSUInteger i=0;i<text.length;i++) {
                BOOL shift;
                if (bytes[i] < 32 || bytes[i] > 126 || !textKey(bytes[i], &shift)) return 2;
            }
        } else if (keyboard) {
            key = strtoul(argv[4], &end, 10);
            if (!end || end == argv[4] || *end || key > 255) return 2;
        } else {
            for (int i=0; i<5; i++) {
                values[i] = strtod(argv[i+4], &end);
                if (!end || end == argv[i+4] || *end || !isfinite(values[i]) || values[i] < 0 || values[i] > (i==4 ? 1000 : 1)) return 2;
            }
            target = strtoul(argv[3], &end, 10);
            if (!end || *end || target == 0 || target > 10) return 2;
        }
        if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)) {
            fprintf(stderr, "CoreSimulator could not be loaded.\n"); return 1;
        }
        NSError *error = nil;
        id context = [NSClassFromString(@"SimServiceContext") sharedServiceContextForDeveloperDir:@(argv[1]) error:&error];
        id set = [context defaultDeviceSetWithError:&error];
        id device = nil;
        for (id candidate in [set availableDevices]) {
            if ([[[candidate valueForKey:@"UDID"] description] isEqualToString:@(argv[2])]) { device = candidate; break; }
        }
        if (!device) { fprintf(stderr, "The simulator could not be found.\n"); return 1; }
        mach_port_t port = [device lookup:@(service) error:&error];
        xpc_object_t (*endpoint)(mach_port_t,uint64_t,uint64_t) = dlsym(RTLD_DEFAULT,"xpc_endpoint_create_mach_port_4sim");
        xpc_connection_t (*connect)(xpc_object_t) = dlsym(RTLD_DEFAULT,"xpc_connection_create_from_endpoint");
        void (*enable)(xpc_connection_t) = dlsym(RTLD_DEFAULT,"xpc_connection_enable_sim2host_4sim");
        if (!port || !endpoint || !connect || !enable) { fprintf(stderr, "Display touch input is unavailable in this Xcode.\n"); return 1; }
        xpc_object_t ep = endpoint(port,0,0);
        xpc_connection_t connection = ep ? connect(ep) : NULL;
        mach_port_deallocate(mach_task_self(), port);
        if (!connection) return 1;
        __block atomic_bool failed = false;
        enable(connection);
        xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
            if (xpc_get_type(event) == XPC_TYPE_ERROR) atomic_store(&failed, true);
        });
        xpc_connection_resume(connection);
        if (typing) {
            BOOL ok = sendKey(connection,225,2) && sendKey(connection,4,2);
            usleep(1000000);
            const unsigned char *bytes = text.bytes;
            for (NSUInteger i=0;ok && !atomic_load(&failed) && i<text.length;i++) {
                BOOL shift;
                uint64_t code = textKey(bytes[i], &shift);
                if (shift) ok = sendKey(connection,225,1);
                ok = ok && sendKey(connection,code,1);
                usleep(10000);
                BOOL released = sendKey(connection,code,2);
                if (shift) released = sendKey(connection,225,2) && released;
                ok = ok && released;
                usleep(10000);
            }
            usleep(150000);
            BOOL completed = ok && !atomic_load(&failed);
            xpc_connection_cancel(connection);
            return completed ? 0 : 1;
        }
        if (keyboard) {
            BOOL ok = sendKey(connection,key,2);
            usleep(1000000);
            ok = ok && !atomic_load(&failed) && sendKey(connection,key,1);
            usleep(100000);
            BOOL released = sendKey(connection,key,2);
            usleep(150000);
            BOOL completed = ok && released && !atomic_load(&failed);
            xpc_connection_cancel(connection);
            if (!completed) { fprintf(stderr, "The simulator keyboard connection failed.\n"); return 1; }
            return 0;
        }
        // DTUHID creates its virtual touchscreen on the first message. Warm it
        // with a release before the gesture: otherwise down/up queue together
        // during service creation and a short tap is silently lost.
        BOOL ok = sendTouch(connection, target, values[0], values[1], 2);
        usleep(1000000);
        ok = ok && !atomic_load(&failed) && sendTouch(connection,target,values[0],values[1],0);
        BOOL swipe = values[0] != values[2] || values[1] != values[3];
        unsigned steps = swipe ? MAX(2, (unsigned)values[4] / 16) : 1;
        for (unsigned i=1; ok && i<=steps; i++) {
            usleep(swipe ? (useconds_t)(values[4]*1000/steps) : 100000);
            if (swipe) ok = sendTouch(connection,target,values[0]+(values[2]-values[0])*i/steps,values[1]+(values[3]-values[1])*i/steps,1);
        }
        // Always release a possible held contact; never retry a touch-down.
        BOOL released = sendTouch(connection,target,values[2],values[3],2);
        usleep(150000);
        BOOL completed = ok && released && !atomic_load(&failed);
        xpc_connection_cancel(connection);
        if (!completed) { fprintf(stderr, "The simulator touch connection failed.\n"); return 1; }
        return 0;
    }
}
