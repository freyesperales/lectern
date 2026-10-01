/* arena.h -- a bump allocator with no individual free.
 *
 * Everything a parse produces lives in one arena, so tearing down a parsed
 * document is a single call instead of a recursive walk. This is the trick
 * that lets json.c return plain pointers everywhere without owning anything.
 */
#ifndef ARENA_H
#define ARENA_H

#include <stddef.h>

/* Allocations are rounded up to this, which is enough for any scalar we
 * store. Keeping it a power of two makes the rounding a mask. */
#define ARENA_ALIGN 16

/* Default size of a fresh block. Blocks grow geometrically after this. */
#define ARENA_BLOCK_MIN 4096

typedef struct arena_block {
    struct arena_block *next;
    size_t              used;
    size_t              cap;
    unsigned char      *base;
} ArenaBlock;

typedef struct arena {
    ArenaBlock *head;
    size_t      total_bytes;
    size_t      block_count;
    size_t      next_block_size;
} Arena;

void   arena_init(Arena *a);
void  *arena_alloc(Arena *a, size_t n);
char  *arena_strndup(Arena *a, const char *s, size_t n);
void   arena_free(Arena *a);
size_t arena_bytes_used(const Arena *a);

#endif /* ARENA_H */
