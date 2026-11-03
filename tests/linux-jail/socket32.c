/* Built with -m32 and -mx32 on x86_64: exits 0 only if it made an AF_UNIX
 * socket, so it must exit 0 on the host and fail in the jail. */
#include <sys/socket.h>
#include <unistd.h>
int main(void) { return socket(AF_UNIX, SOCK_STREAM, 0) < 0 ? 1 : 0; }
