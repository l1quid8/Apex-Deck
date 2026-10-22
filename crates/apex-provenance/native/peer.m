#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <bsm/libbsm.h>

// The kernel's audit token includes the PID version. Do not replace this with
// getpeereid + a PID lookup: that introduces a PID-reuse/exec race.
int apex_provenance_peer(int fd, const char *requirement, uint32_t *uid) {
    @autoreleasepool {
        audit_token_t token;
        socklen_t size = sizeof(token);
        if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &size) != 0 || size != sizeof(token)) return 0;
        *uid = audit_token_to_euid(token);
        NSData *data = [NSData dataWithBytes:&token length:sizeof(token)];
        NSDictionary *attributes = @{(__bridge NSString *)kSecGuestAttributeAudit: data};
        SecCodeRef code = NULL;
        if (SecCodeCopyGuestWithAttributes(NULL, (__bridge CFDictionaryRef)attributes, kSecCSDefaultFlags, &code) != errSecSuccess) return 0;
        SecRequirementRef rule = NULL;
        OSStatus result = SecRequirementCreateWithString((__bridge CFStringRef)[NSString stringWithUTF8String:requirement], kSecCSDefaultFlags, &rule);
        if (result == errSecSuccess) result = SecCodeCheckValidity(code, kSecCSDefaultFlags, rule);
        if (result == errSecSuccess) {
            CFDictionaryRef raw = NULL;
            result = SecCodeCopySigningInformation(code, kSecCSSigningInformation, &raw);
            if (result == errSecSuccess) {
                NSDictionary *info = CFBridgingRelease(raw);
                uint32_t flags = [info[(__bridge NSString *)kSecCodeInfoFlags] unsignedIntValue];
                NSDictionary *ent = info[(__bridge NSString *)kSecCodeInfoEntitlementsDict];
                if (!(flags & 0x10000) || (flags & 0x4)) result = errSecCSUnsigned; // runtime / get-task-allow
                for (NSString *name in @[@"com.apple.security.get-task-allow", @"com.apple.security.cs.disable-library-validation", @"com.apple.security.cs.allow-dyld-environment-variables", @"com.apple.security.cs.allow-unsigned-executable-memory"]) {
                    if ([ent[name] boolValue]) result = errSecCSUnsigned;
                }
            }
        }
        if (result == errSecSuccess) {
            SecStaticCodeRef disk = NULL;
            result = SecCodeCopyStaticCode(code, kSecCSDefaultFlags, &disk);
            if (result == errSecSuccess) result = SecStaticCodeCheckValidity(disk, kSecCSStrictValidate | kSecCSCheckAllArchitectures, rule);
            if (disk) CFRelease(disk);
        }
        // A pinned executable must not load its sealed resources from a tree
        // that the worker can replace after validation. Production installation
        // copies the UI below the root-owned broker directory, not ~/Downloads.
        if (result == errSecSuccess) {
            CFURLRef url = NULL;
            result = SecCodeCopyPath(code, kSecCSDefaultFlags, &url);
            if (result == errSecSuccess) {
                NSString *path = [(__bridge NSURL *)url path];
                while (path.length > 0) {
                    struct stat st;
                    if (lstat(path.fileSystemRepresentation, &st) != 0 || S_ISLNK(st.st_mode) || st.st_uid != 0 || (st.st_mode & 0022)) { result = errSecCSUnsigned; break; }
                    if ([path isEqualToString:@"/"]) break;
                    path = [path stringByDeletingLastPathComponent];
                }
            }
            if (url) CFRelease(url);
        }
        if (rule) CFRelease(rule);
        CFRelease(code);
        return result == errSecSuccess;
    }
}
