#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include "watch.h"
#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t stopped;
static void stop_watch(int signal_number) { (void)signal_number; stopped = 1; }

static double now(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

/* Check contents rather than timestamps: atomic saves, equal-sized edits, and
 * coarse filesystem clocks all work. Two equal samples debounce writes. */
static int fingerprint(const char *path, uint64_t *hash) {
    struct stat st;
    if (stat(path, &st) || !S_ISREG(st.st_mode)) return 0;
    int fd = open(path, O_RDONLY | O_NONBLOCK);
    if (fd < 0) return 0;
    if (fstat(fd, &st) || !S_ISREG(st.st_mode)) { close(fd); return 0; }
    FILE *f = fdopen(fd, "rb");
    if (!f) { close(fd); return 0; }
    uint64_t value = UINT64_C(14695981039346656037);
    unsigned char chunk[8192]; size_t n;
    while ((n = fread(chunk, 1, sizeof(chunk), f))) {
        for (size_t i = 0; i < n; ++i) { value ^= chunk[i]; value *= UINT64_C(1099511628211); }
    }
    int failed = ferror(f);
    if (fclose(f)) failed = 1;
    if (failed) return 0;
    *hash = value; return 1;
}

static int send_all(int fd, const char *data, size_t length) {
    while (length && !stopped) {
        ssize_t n = send(fd, data, length, 0);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return 0;
        data += n; length -= (size_t)n;
    }
    return !length;
}

static int headers(int fd, int status, const char *type, size_t length) {
    char buffer[512];
    snprintf(buffer, sizeof(buffer),
             "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\n"
             "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n"
             "Connection: close\r\n\r\n",
             status, status == 200 ? "OK" : "Error", type, length);
    return send_all(fd, buffer, strlen(buffer));
}

static void reply(int fd, int status, const char *message) {
    if (headers(fd, status, "text/plain; charset=utf-8", strlen(message)))
        send_all(fd, message, strlen(message));
}

static const char *mime_type(const char *path) {
    const char *ext = strrchr(path, '.');
    if (!ext) return "application/octet-stream";
    static const struct { const char *ext, *type; } types[] = {
        {".html", "text/html; charset=utf-8"}, {".htm", "text/html; charset=utf-8"},
        {".md", "text/plain; charset=utf-8"}, {".txt", "text/plain; charset=utf-8"},
        {".svg", "image/svg+xml"}, {".png", "image/png"}, {".jpg", "image/jpeg"},
        {".jpeg", "image/jpeg"}, {".gif", "image/gif"}, {".webp", "image/webp"},
        {".avif", "image/avif"}, {".ico", "image/x-icon"}, {".pdf", "application/pdf"},
        {".css", "text/css"}, {".js", "text/javascript"}
    };
    for (size_t i = 0; i < sizeof(types) / sizeof(*types); ++i)
        if (!strcasecmp(ext, types[i].ext)) return types[i].type;
    return "application/octet-stream";
}

static void serve_file(int fd, const char *path, const char *type, int head) {
    /* O_NONBLOCK prevents a replaced asset or output FIFO from stalling watch. */
    int file = open(path, O_RDONLY | O_NONBLOCK);
    struct stat st;
    if (file < 0 || fstat(file, &st) || !S_ISREG(st.st_mode)) {
        if (file >= 0) close(file);
        reply(fd, 404, "Not found\n"); return;
    }
    if (headers(fd, 200, type, (size_t)st.st_size) && !head) {
        char buffer[16384]; ssize_t n;
        double deadline = now() + 2;
        while (!stopped && now() < deadline && (n = read(file, buffer, sizeof(buffer))) > 0)
            if (!send_all(fd, buffer, (size_t)n)) break;
    }
    close(file);
}

static int hex_digit(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    c = (char)tolower((unsigned char)c);
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

static int decode_path(char *path) {
    char *to = path;
    for (char *from = path; *from; ++from) {
        if (*from == '%') {
            if (!from[1] || !from[2]) return 0;
            int a = hex_digit(from[1]), b = hex_digit(from[2]);
            if (a < 0 || b < 0 || !(a * 16 + b)) return 0;
            *to++ = (char)(a * 16 + b); from += 2;
        } else *to++ = *from;
    }
    *to = '\0'; return 1;
}

static void serve_client(int fd, const char *output, const char *directory,
                         const char *host, unsigned long revision) {
    struct timeval timeout = {0, 250000};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    char request[8192]; size_t used = 0;
    double deadline = now() + .25;
    while (!stopped && now() < deadline && used < sizeof(request) - 1) {
        ssize_t n = recv(fd, request + used, sizeof(request) - used - 1, 0);
        if (n <= 0) return;
        used += (size_t)n; request[used] = '\0';
        if (strstr(request, "\r\n\r\n")) break;
    }
    if (!used || !strstr(request, "\r\n\r\n")) { reply(fd, 400, "Bad request\n"); return; }
    char method[16], path[4096], version[16];
    if (sscanf(request, "%15s %4095s %15s", method, path, version) != 3) {
        reply(fd, 400, "Bad request\n"); return;
    }
    int head = !strcmp(method, "HEAD");
    if (strcmp(method, "GET") && !head) { reply(fd, 405, "Use GET or HEAD\n"); return; }
    /* Accept only our loopback authority, including the ephemeral port. This
     * blocks DNS rebinding; no cross-origin access is enabled. */
    int valid_host = 0;
    char *line = strstr(request, "\r\n");
    while (line && line[2]) {
        line += 2;
        char *end = strstr(line, "\r\n");
        if (!end || end == line) break;
        if (!strncasecmp(line, "Host:", 5)) {
            char *value = line + 5;
            while (value < end && (*value == ' ' || *value == '\t')) ++value;
            while (end > value && (end[-1] == ' ' || end[-1] == '\t')) --end;
            valid_host = (size_t)(end - value) == strlen(host) && !memcmp(value, host, strlen(host));
            break;
        }
        line = end;
    }
    if (!valid_host) { reply(fd, 403, "Forbidden host\n"); return; }
    char *query = strchr(path, '?'); if (query) *query = '\0';
    if (!strcmp(path, "/preview") || !strcmp(path, "/"))
        serve_file(fd, output, "text/html; charset=utf-8", head);
    else if (!strcmp(path, "/revision")) {
        char value[32]; snprintf(value, sizeof(value), "%lu\n", revision);
        if (headers(fd, 200, "text/plain; charset=utf-8", strlen(value)) && !head)
            send_all(fd, value, strlen(value));
    } else if (!strncmp(path, "/files/", 7) && decode_path(path + 6)) {
        char *resolved = realpath(path + 6, NULL);
        size_t length = strlen(directory);
        if (resolved && !strncmp(resolved, directory, length) &&
            (directory[length - 1] == '/' || resolved[length] == '/'))
            serve_file(fd, resolved, mime_type(resolved), head);
        else reply(fd, 404, "Not found\n");
        free(resolved);
    } else reply(fd, 404, "Not found\n");
}

/* Render in a worker so a malformed edit (including parser limits) cannot
 * terminate the server. Rename only a complete successful render into place. */
static int update(const char *input, const char *output, unsigned long revision,
                  char *(*render)(const char *, const char *, unsigned long)) {
    struct stat source, target;
    if (!stat(input, &source) && !stat(output, &target) &&
        source.st_dev == target.st_dev && source.st_ino == target.st_ino) {
        fprintf(stderr, "mdview: output would overwrite the Markdown input\n"); return 0;
    }
    size_t length = strlen(output) + sizeof(".watch-XXXXXX");
    char *staging = malloc(length);
    if (!staging) return 0;
    snprintf(staging, length, "%s.watch-XXXXXX", output);
    int fd = mkstemp(staging);
    if (fd < 0) { fprintf(stderr, "mdview: cannot stage HTML: %s\n", strerror(errno)); free(staging); return 0; }
    if (!stat(output, &target)) fchmod(fd, target.st_mode & 0777);
    close(fd);
    fflush(NULL);
    pid_t pid = fork();
    if (pid == 0) {
        signal(SIGINT, SIG_DFL); signal(SIGTERM, SIG_DFL);
        char *path = render(input, staging, revision);
        int result = path ? 0 : 1;
        free(path); _exit(result);
    }
    int status = 0, ok = 0;
    if (pid > 0) {
        pid_t waited;
        do { waited = waitpid(pid, &status, 0); } while (waited < 0 && errno == EINTR);
        if (waited == pid && WIFEXITED(status) && !WEXITSTATUS(status) && !stopped) {
            ok = rename(staging, output) == 0;
            if (!ok) fprintf(stderr, "mdview: cannot replace HTML: %s\n", strerror(errno));
        }
    } else fprintf(stderr, "mdview: cannot render update: %s\n", strerror(errno));
    unlink(staging); free(staging); return ok;
}

int watch_preview(const char *input, const char *output,
                  int (*launch)(const char *),
                  char *(*render)(const char *, const char *, unsigned long)) {
    uint64_t accepted = 0, pending = 0;
    if (!fingerprint(input, &accepted)) {
        fprintf(stderr, "mdview: cannot read watched file\n"); return 1;
    }
    char *directory = realpath(input, NULL);
    if (!directory) return 1;
    char *slash = strrchr(directory, '/');
    if (slash == directory) slash[1] = '\0'; else *slash = '\0';
    char *html = render(input, output, 1);
    if (!html) { free(directory); return 1; }
    int server = socket(AF_INET, SOCK_STREAM, 0), status = 1;
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    socklen_t size = sizeof(address);
    if (server < 0 || bind(server, (struct sockaddr *)&address, sizeof(address)) ||
        listen(server, 8) || getsockname(server, (struct sockaddr *)&address, &size)) {
        fprintf(stderr, "mdview: cannot start preview server: %s\n", strerror(errno)); goto done;
    }
    fcntl(server, F_SETFD, FD_CLOEXEC);
    struct sigaction action = {0}, old_int, old_term, old_pipe;
    action.sa_handler = stop_watch; sigemptyset(&action.sa_mask);
    sigaction(SIGINT, &action, &old_int); sigaction(SIGTERM, &action, &old_term);
    action.sa_handler = SIG_IGN; sigaction(SIGPIPE, &action, &old_pipe);
    stopped = 0;
    char host[64], url[96];
    snprintf(host, sizeof(host), "127.0.0.1:%u", (unsigned)ntohs(address.sin_port));
    snprintf(url, sizeof(url), "http://%s/preview", host);
    puts(url); fflush(stdout);
    fprintf(stderr, "mdview: watching %s (Ctrl+C to stop)\nmdview: HTML saved to %s\n", input, html);
    status = launch ? launch(url) : 0;
    unsigned long revision = 1;
    int has_pending = 0, missing = 0;
    double next_check = now();
    while (!status && !stopped) {
        if (now() >= next_check) {
            uint64_t current;
            next_check = now() + .25;
            if (!fingerprint(input, &current)) {
                if (!missing) fprintf(stderr, "mdview: watched file unavailable; keeping the last preview\n");
                missing = 1; has_pending = 0;
            } else {
                missing = 0;
                if (current == accepted) has_pending = 0;
                else if (!has_pending || current != pending) { pending = current; has_pending = 1; }
                else {
                    if (update(input, html, revision + 1, render)) ++revision;
                    else if (!stopped) fprintf(stderr, "mdview: render failed; keeping the last preview\n");
                    accepted = current; has_pending = 0;
                }
            }
        }
        fd_set readers; FD_ZERO(&readers); FD_SET(server, &readers);
        double delay = next_check - now(); if (delay < 0) delay = 0;
        struct timeval timeout = {0, (suseconds_t)(delay * 1e6)};
        int ready = select(server + 1, &readers, NULL, NULL, &timeout);
        if (ready < 0) {
            if (errno == EINTR) continue;
            fprintf(stderr, "mdview: preview server failed: %s\n", strerror(errno)); status = 1; break;
        }
        if (ready && !stopped) {
            int client = accept(server, NULL, NULL);
            if (client >= 0) { serve_client(client, html, directory, host, revision); close(client); }
        }
    }
    sigaction(SIGINT, &old_int, NULL); sigaction(SIGTERM, &old_term, NULL);
    sigaction(SIGPIPE, &old_pipe, NULL);
done:
    if (server >= 0) close(server);
    free(html); free(directory); return status;
}
