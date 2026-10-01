#include "arena.h"

#include <stdlib.h>
#include <string.h>

/* Round n up to the next multiple of ARENA_ALIGN. */
static size_t align_up(size_t n)
{
    return (n + (ARENA_ALIGN - 1)) & ~(size_t)(ARENA_ALIGN - 1);
}

void arena_init(Arena *a)
{
    a->head = NULL;
    a->total_bytes = 0;
    a->block_count = 0;
    a->next_block_size = ARENA_BLOCK_MIN;
}

/* Attach a new block big enough for the requested size, and make it the head. */
static ArenaBlock *grow(Arena *a, size_t need)
{
    size_t cap = a->next_block_size;
    while (cap < need) {
        cap *= 2;
    }

    ArenaBlock *b = malloc(sizeof *b);
    if (b == NULL) {
        return NULL;
    }
    b->base = malloc(cap);
    if (b->base == NULL) {
        free(b);
        return NULL;
    }

    b->next = a->head;
    b->used = 0;
    b->cap = cap;
    a->head = b;
    a->block_count++;
    a->next_block_size = cap * 2;
    return b;
}

void *arena_alloc(Arena *a, size_t n)
{
    size_t want = align_up(n == 0 ? 1 : n);
    ArenaBlock *b = a->head;

    if (b == NULL || b->cap - b->used < want) {
        b = grow(a, want);
        if (b == NULL) {
            return NULL;
        }
    }

    unsigned char *p = b->base + b->used;
    b->used += want;
    a->total_bytes += want;
    return p;
}

char *arena_strndup(Arena *a, const char *s, size_t n)
{
    char *out = arena_alloc(a, n + 1);
    if (out == NULL) {
        return NULL;
    }
    memcpy(out, s, n);
    out[n] = '\0';
    return out;
}

void arena_free(Arena *a)
{
    ArenaBlock *b = a->head;
    while (b != NULL) {
        ArenaBlock *next = b->next;
        free(b->base);
        free(b);
        b = next;
    }
    arena_init(a);
}

size_t arena_bytes_used(const Arena *a)
{
    return a->total_bytes;
}
