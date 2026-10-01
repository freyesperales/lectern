#include "json.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Forward declarations, because parse_value and the two container parsers
 * call each other. */
static JsonValue *parse_value(JsonParser *p);
static JsonValue *parse_array(JsonParser *p);
static JsonValue *parse_object(JsonParser *p);

static void fail(JsonParser *p, const char *message)
{
    if (p->failed) {
        return; /* keep the first error, which is the useful one */
    }
    p->failed = 1;
    p->error.message = message;
    p->error.offset = p->pos;
    p->error.line = p->line;
    p->error.column = (int)(p->pos - (size_t)p->line_start) + 1;
}

static int at_end(const JsonParser *p)
{
    return p->pos >= p->len;
}

static char peek(const JsonParser *p)
{
    return at_end(p) ? '\0' : p->text[p->pos];
}

static char advance(JsonParser *p)
{
    char c = p->text[p->pos++];
    if (c == '\n') {
        p->line++;
        p->line_start = (int)p->pos;
    }
    return c;
}

static void skip_whitespace(JsonParser *p)
{
    while (!at_end(p)) {
        char c = peek(p);
        if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
            advance(p);
        } else {
            break;
        }
    }
}

static int match(JsonParser *p, char c)
{
    if (peek(p) != c) {
        return 0;
    }
    advance(p);
    return 1;
}

static JsonValue *new_value(JsonParser *p, JsonKind kind)
{
    JsonValue *v = arena_alloc(p->arena, sizeof *v);
    if (v == NULL) {
        fail(p, "out of memory");
        return NULL;
    }
    memset(v, 0, sizeof *v);
    v->kind = kind;
    return v;
}

/* Consume a bare word and compare it with the expected literal; used for the
 * three JSON literals, which is cheaper than a general identifier scan. */
static int keyword(JsonParser *p, const char *word)
{
    size_t n = strlen(word);
    if (p->len - p->pos < n) {
        return 0;
    }
    if (memcmp(p->text + p->pos, word, n) != 0) {
        return 0;
    }
    for (size_t i = 0; i < n; i++) {
        advance(p);
    }
    return 1;
}

static JsonValue *parse_literal(JsonParser *p)
{
    if (keyword(p, "null")) {
        return new_value(p, JSON_NULL);
    }
    if (keyword(p, "true")) {
        JsonValue *v = new_value(p, JSON_BOOL);
        if (v != NULL) {
            v->as.boolean = 1;
        }
        return v;
    }
    if (keyword(p, "false")) {
        JsonValue *v = new_value(p, JSON_BOOL);
        if (v != NULL) {
            v->as.boolean = 0;
        }
        return v;
    }
    fail(p, "expected a value");
    return NULL;
}

static JsonValue *parse_number(JsonParser *p)
{
    size_t start = p->pos;

    if (peek(p) == '-') {
        advance(p);
    }
    while (!at_end(p) && peek(p) >= '0' && peek(p) <= '9') {
        advance(p);
    }
    if (peek(p) == '.') {
        advance(p);
        while (!at_end(p) && peek(p) >= '0' && peek(p) <= '9') {
            advance(p);
        }
    }
    if (peek(p) == 'e' || peek(p) == 'E') {
        advance(p);
        if (peek(p) == '+' || peek(p) == '-') {
            advance(p);
        }
        while (!at_end(p) && peek(p) >= '0' && peek(p) <= '9') {
            advance(p);
        }
    }

    if (p->pos == start) {
        fail(p, "expected a number");
        return NULL;
    }

    char *copy = arena_strndup(p->arena, p->text + start, p->pos - start);
    if (copy == NULL) {
        fail(p, "out of memory");
        return NULL;
    }

    JsonValue *v = new_value(p, JSON_NUMBER);
    if (v != NULL) {
        v->as.number = strtod(copy, NULL);
    }
    return v;
}

/* Decode a \uXXXX escape into UTF-8. Surrogate pairs are joined; a lone
 * surrogate is written as U+FFFD rather than rejected, so one bad escape does
 * not throw away an otherwise good document. */
static int decode_hex4(JsonParser *p, unsigned *out)
{
    unsigned value = 0;
    for (int i = 0; i < 4; i++) {
        if (at_end(p)) {
            return 0;
        }
        char c = advance(p);
        unsigned digit;
        if (c >= '0' && c <= '9') {
            digit = (unsigned)(c - '0');
        } else if (c >= 'a' && c <= 'f') {
            digit = (unsigned)(c - 'a') + 10u;
        } else if (c >= 'A' && c <= 'F') {
            digit = (unsigned)(c - 'A') + 10u;
        } else {
            return 0;
        }
        value = (value << 4) | digit;
    }
    *out = value;
    return 1;
}

static size_t encode_utf8(unsigned cp, char *buf)
{
    if (cp < 0x80u) {
        buf[0] = (char)cp;
        return 1;
    }
    if (cp < 0x800u) {
        buf[0] = (char)(0xC0u | (cp >> 6));
        buf[1] = (char)(0x80u | (cp & 0x3Fu));
        return 2;
    }
    if (cp < 0x10000u) {
        buf[0] = (char)(0xE0u | (cp >> 12));
        buf[1] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
        buf[2] = (char)(0x80u | (cp & 0x3Fu));
        return 3;
    }
    buf[0] = (char)(0xF0u | (cp >> 18));
    buf[1] = (char)(0x80u | ((cp >> 12) & 0x3Fu));
    buf[2] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
    buf[3] = (char)(0x80u | (cp & 0x3Fu));
    return 4;
}

static int parse_string_raw(JsonParser *p, const char **bytes, size_t *len)
{
    if (!match(p, '"')) {
        fail(p, "expected a string");
        return 0;
    }

    /* Worst case the decoded form is no longer than the encoded form, so one
     * upper-bound allocation is enough and no resizing is needed. */
    size_t budget = p->len - p->pos + 1;
    char *out = arena_alloc(p->arena, budget);
    if (out == NULL) {
        fail(p, "out of memory");
        return 0;
    }

    size_t n = 0;
    while (!at_end(p)) {
        char c = advance(p);
        if (c == '"') {
            out[n] = '\0';
            *bytes = out;
            *len = n;
            return 1;
        }
        if (c != '\\') {
            out[n++] = c;
            continue;
        }
        if (at_end(p)) {
            break;
        }
        char esc = advance(p);
        switch (esc) {
        case '"':  out[n++] = '"';  break;
        case '\\': out[n++] = '\\'; break;
        case '/':  out[n++] = '/';  break;
        case 'b':  out[n++] = '\b'; break;
        case 'f':  out[n++] = '\f'; break;
        case 'n':  out[n++] = '\n'; break;
        case 'r':  out[n++] = '\r'; break;
        case 't':  out[n++] = '\t'; break;
        case 'u': {
            unsigned cp;
            if (!decode_hex4(p, &cp)) {
                fail(p, "malformed \\u escape");
                return 0;
            }
            if (cp >= 0xD800u && cp <= 0xDBFFu) {
                unsigned low;
                if (match(p, '\\') && match(p, 'u') && decode_hex4(p, &low) &&
                    low >= 0xDC00u && low <= 0xDFFFu) {
                    cp = 0x10000u + ((cp - 0xD800u) << 10) + (low - 0xDC00u);
                } else {
                    cp = 0xFFFDu;
                }
            } else if (cp >= 0xDC00u && cp <= 0xDFFFu) {
                cp = 0xFFFDu;
            }
            n += encode_utf8(cp, out + n);
            break;
        }
        default:
            fail(p, "unknown escape sequence");
            return 0;
        }
    }

    fail(p, "unterminated string");
    return 0;
}

static JsonValue *parse_string(JsonParser *p)
{
    const char *bytes;
    size_t len;
    if (!parse_string_raw(p, &bytes, &len)) {
        return NULL;
    }
    JsonValue *v = new_value(p, JSON_STRING);
    if (v != NULL) {
        v->as.string.bytes = bytes;
        v->as.string.len = len;
    }
    return v;
}

static JsonValue *parse_array(JsonParser *p)
{
    if (!match(p, '[')) {
        fail(p, "expected '['");
        return NULL;
    }
    JsonValue *v = new_value(p, JSON_ARRAY);
    if (v == NULL) {
        return NULL;
    }

    skip_whitespace(p);
    if (match(p, ']')) {
        return v;
    }

    JsonElement *tail = NULL;
    for (;;) {
        JsonValue *item = parse_value(p);
        if (item == NULL) {
            return NULL;
        }

        JsonElement *node = arena_alloc(p->arena, sizeof *node);
        if (node == NULL) {
            fail(p, "out of memory");
            return NULL;
        }
        node->value = item;
        node->next = NULL;
        if (tail == NULL) {
            v->as.array.first = node;
        } else {
            tail->next = node;
        }
        tail = node;
        v->as.array.count++;

        skip_whitespace(p);
        if (match(p, ',')) {
            skip_whitespace(p);
            continue;
        }
        if (match(p, ']')) {
            return v;
        }
        fail(p, "expected ',' or ']' in array");
        return NULL;
    }
}

static JsonValue *parse_object(JsonParser *p)
{
    if (!match(p, '{')) {
        fail(p, "expected '{'");
        return NULL;
    }
    JsonValue *v = new_value(p, JSON_OBJECT);
    if (v == NULL) {
        return NULL;
    }

    skip_whitespace(p);
    if (match(p, '}')) {
        return v;
    }

    JsonMember *tail = NULL;
    for (;;) {
        skip_whitespace(p);

        const char *key;
        size_t key_len;
        if (!parse_string_raw(p, &key, &key_len)) {
            return NULL;
        }

        skip_whitespace(p);
        if (!match(p, ':')) {
            fail(p, "expected ':' after object key");
            return NULL;
        }

        JsonValue *item = parse_value(p);
        if (item == NULL) {
            return NULL;
        }

        JsonMember *node = arena_alloc(p->arena, sizeof *node);
        if (node == NULL) {
            fail(p, "out of memory");
            return NULL;
        }
        node->key = key;
        node->key_len = key_len;
        node->value = item;
        node->next = NULL;
        if (tail == NULL) {
            v->as.object.first = node;
        } else {
            tail->next = node;
        }
        tail = node;
        v->as.object.count++;

        skip_whitespace(p);
        if (match(p, ',')) {
            continue;
        }
        if (match(p, '}')) {
            return v;
        }
        fail(p, "expected ',' or '}' in object");
        return NULL;
    }
}

static JsonValue *parse_value(JsonParser *p)
{
    if (p->depth >= JSON_MAX_DEPTH) {
        fail(p, "nesting too deep");
        return NULL;
    }

    skip_whitespace(p);
    if (at_end(p)) {
        fail(p, "unexpected end of input");
        return NULL;
    }

    p->depth++;
    JsonValue *v;
    char c = peek(p);
    if (c == '{') {
        v = parse_object(p);
    } else if (c == '[') {
        v = parse_array(p);
    } else if (c == '"') {
        v = parse_string(p);
    } else if (c == '-' || (c >= '0' && c <= '9')) {
        v = parse_number(p);
    } else {
        v = parse_literal(p);
    }
    p->depth--;
    return v;
}

JsonValue *json_parse(Arena *arena, const char *text, size_t len, JsonError *err)
{
    JsonParser p;
    memset(&p, 0, sizeof p);
    p.text = text;
    p.len = len;
    p.line = 1;
    p.arena = arena;

    JsonValue *root = parse_value(&p);
    if (root != NULL) {
        skip_whitespace(&p);
        if (!at_end(&p)) {
            fail(&p, "trailing content after the top-level value");
            root = NULL;
        }
    }

    if (err != NULL) {
        *err = p.error;
    }
    return p.failed ? NULL : root;
}

const char *json_kind_name(JsonKind k)
{
    switch (k) {
    case JSON_NULL:   return "null";
    case JSON_BOOL:   return "bool";
    case JSON_NUMBER: return "number";
    case JSON_STRING: return "string";
    case JSON_ARRAY:  return "array";
    case JSON_OBJECT: return "object";
    }
    return "?";
}

JsonValue *json_object_get(const JsonValue *obj, const char *key)
{
    if (obj == NULL || obj->kind != JSON_OBJECT) {
        return NULL;
    }
    size_t n = strlen(key);
    for (JsonMember *m = obj->as.object.first; m != NULL; m = m->next) {
        if (m->key_len == n && memcmp(m->key, key, n) == 0) {
            return m->value;
        }
    }
    return NULL;
}

static void put_indent(FILE *f, int depth, int indent)
{
    if (indent <= 0) {
        return;
    }
    fputc('\n', f);
    for (int i = 0; i < depth * indent; i++) {
        fputc(' ', f);
    }
}

static void print_escaped(FILE *f, const char *s, size_t len)
{
    fputc('"', f);
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)s[i];
        switch (c) {
        case '"':  fputs("\\\"", f); break;
        case '\\': fputs("\\\\", f); break;
        case '\n': fputs("\\n", f);  break;
        case '\r': fputs("\\r", f);  break;
        case '\t': fputs("\\t", f);  break;
        default:
            if (c < 0x20) {
                fprintf(f, "\\u%04x", c);
            } else {
                fputc((int)c, f);
            }
        }
    }
    fputc('"', f);
}

static void print_value(const JsonValue *v, int indent, int depth, FILE *f)
{
    if (v == NULL) {
        fputs("null", f);
        return;
    }

    switch (v->kind) {
    case JSON_NULL:
        fputs("null", f);
        break;
    case JSON_BOOL:
        fputs(v->as.boolean ? "true" : "false", f);
        break;
    case JSON_NUMBER:
        fprintf(f, "%.17g", v->as.number);
        break;
    case JSON_STRING:
        print_escaped(f, v->as.string.bytes, v->as.string.len);
        break;
    case JSON_ARRAY: {
        fputc('[', f);
        int first = 1;
        for (JsonElement *e = v->as.array.first; e != NULL; e = e->next) {
            if (!first) {
                fputc(',', f);
            }
            first = 0;
            put_indent(f, depth + 1, indent);
            print_value(e->value, indent, depth + 1, f);
        }
        if (!first) {
            put_indent(f, depth, indent);
        }
        fputc(']', f);
        break;
    }
    case JSON_OBJECT: {
        fputc('{', f);
        int first = 1;
        for (JsonMember *m = v->as.object.first; m != NULL; m = m->next) {
            if (!first) {
                fputc(',', f);
            }
            first = 0;
            put_indent(f, depth + 1, indent);
            print_escaped(f, m->key, m->key_len);
            fputc(':', f);
            if (indent > 0) {
                fputc(' ', f);
            }
            print_value(m->value, indent, depth + 1, f);
        }
        if (!first) {
            put_indent(f, depth, indent);
        }
        fputc('}', f);
        break;
    }
    }
}

void json_print(const JsonValue *v, int indent, void *out)
{
    FILE *f = out == NULL ? stdout : (FILE *)out;
    print_value(v, indent, 0, f);
    fputc('\n', f);
}
