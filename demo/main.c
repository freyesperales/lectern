/* main.c -- read JSON on stdin or from a file, print it back formatted.
 *
 * Usage: jsonfmt [-c] [-i N] [file]
 *   -c     compact output (no newlines or indentation)
 *   -i N   indent with N spaces (default 2)
 */
#include "arena.h"
#include "json.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define READ_CHUNK 65536

typedef struct options {
    int         indent;
    const char *path;
} Options;

static void usage(const char *argv0)
{
    fprintf(stderr, "usage: %s [-c] [-i N] [file]\n", argv0);
}

static int parse_options(int argc, char **argv, Options *opt)
{
    opt->indent = 2;
    opt->path = NULL;

    for (int i = 1; i < argc; i++) {
        const char *arg = argv[i];
        if (strcmp(arg, "-c") == 0) {
            opt->indent = 0;
        } else if (strcmp(arg, "-i") == 0) {
            if (i + 1 >= argc) {
                fprintf(stderr, "-i needs a value\n");
                return 0;
            }
            opt->indent = atoi(argv[++i]);
            if (opt->indent < 0) {
                fprintf(stderr, "-i needs a non-negative value\n");
                return 0;
            }
        } else if (arg[0] == '-' && arg[1] != '\0') {
            fprintf(stderr, "unknown option: %s\n", arg);
            return 0;
        } else {
            opt->path = arg;
        }
    }
    return 1;
}

/* Slurp a whole stream into the arena, growing geometrically. */
static char *read_all(Arena *a, FILE *f, size_t *out_len)
{
    size_t cap = READ_CHUNK;
    size_t len = 0;
    char *buf = arena_alloc(a, cap);
    if (buf == NULL) {
        return NULL;
    }

    for (;;) {
        size_t room = cap - len;
        if (room == 0) {
            size_t bigger = cap * 2;
            char *grown = arena_alloc(a, bigger);
            if (grown == NULL) {
                return NULL;
            }
            memcpy(grown, buf, len);
            buf = grown;
            cap = bigger;
            continue;
        }
        size_t got = fread(buf + len, 1, room, f);
        len += got;
        if (got < room) {
            if (ferror(f)) {
                return NULL;
            }
            break;
        }
    }

    *out_len = len;
    return buf;
}

static void report(const JsonError *err, const char *path)
{
    fprintf(stderr, "%s:%d:%d: %s\n",
            path == NULL ? "<stdin>" : path,
            err->line, err->column,
            err->message == NULL ? "parse failed" : err->message);
}

int main(int argc, char **argv)
{
    Options opt;
    if (!parse_options(argc, argv, &opt)) {
        usage(argv[0]);
        return 2;
    }

    FILE *in = stdin;
    if (opt.path != NULL) {
        in = fopen(opt.path, "rb");
        if (in == NULL) {
            fprintf(stderr, "cannot open %s\n", opt.path);
            return 2;
        }
    }

    Arena arena;
    arena_init(&arena);

    size_t len = 0;
    char *text = read_all(&arena, in, &len);
    if (in != stdin) {
        fclose(in);
    }
    if (text == NULL) {
        fprintf(stderr, "read failed\n");
        arena_free(&arena);
        return 1;
    }

    JsonError err;
    memset(&err, 0, sizeof err);
    JsonValue *root = json_parse(&arena, text, len, &err);
    if (root == NULL) {
        report(&err, opt.path);
        arena_free(&arena);
        return 1;
    }

    json_print(root, opt.indent, stdout);
    fprintf(stderr, "%s: %zu bytes in %zu arena blocks\n",
            json_kind_name(root->kind),
            arena_bytes_used(&arena),
            arena.block_count);

    arena_free(&arena);
    return 0;
}
