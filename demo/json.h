/* json.h -- a recursive-descent JSON reader that allocates from an arena.
 *
 * The parser is mutually recursive: a value may be an array or an object, and
 * both of those contain values. That cycle is deliberate here -- it is what
 * lectern's reading order has to condense into a single component, so the demo
 * carries a real example of the thing rather than a contrived one.
 */
#ifndef JSON_H
#define JSON_H

#include "arena.h"

#include <stddef.h>

#define JSON_MAX_DEPTH 64

typedef enum json_kind {
    JSON_NULL,
    JSON_BOOL,
    JSON_NUMBER,
    JSON_STRING,
    JSON_ARRAY,
    JSON_OBJECT
} JsonKind;

typedef struct json_value JsonValue;

/* One key/value pair of an object, kept as a singly linked list so appending
 * during a parse needs no reallocation. */
typedef struct json_member {
    const char         *key;
    size_t              key_len;
    JsonValue          *value;
    struct json_member *next;
} JsonMember;

typedef struct json_element {
    JsonValue           *value;
    struct json_element *next;
} JsonElement;

struct json_value {
    JsonKind kind;
    union {
        int    boolean;
        double number;
        struct {
            const char *bytes;
            size_t      len;
        } string;
        struct {
            JsonElement *first;
            size_t       count;
        } array;
        struct {
            JsonMember *first;
            size_t      count;
        } object;
    } as;
};

typedef struct json_error {
    const char *message;
    size_t      offset;
    int         line;
    int         column;
} JsonError;

typedef struct json_parser {
    const char *text;
    size_t      len;
    size_t      pos;
    int         line;
    int         line_start;
    int         depth;
    Arena      *arena;
    JsonError   error;
    int         failed;
} JsonParser;

JsonValue  *json_parse(Arena *arena, const char *text, size_t len, JsonError *err);
void        json_print(const JsonValue *v, int indent, void *out);
const char *json_kind_name(JsonKind k);
JsonValue  *json_object_get(const JsonValue *obj, const char *key);

#endif /* JSON_H */
