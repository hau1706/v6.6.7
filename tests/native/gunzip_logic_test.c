// Logic-port test: mirrors the control flow of -[FridaController gunzipData:status:] in plain C
// (NSMutableData -> malloc buffer). It validates the zlib branches/limits, not the Objective-C bindings.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <assert.h>
#include <zlib.h>
enum { OK = 0, CORRUPT = 1, TOO_LARGE = 2 };
#define MAX_OUT (4u * 1024u * 1024u)
#define MAX_IN  (1u * 1024u * 1024u)
static int gunzip(const uint8_t *in, size_t n, size_t *outLen, int *passthrough) {
    *outLen = 0; *passthrough = 0;
    if (n < 2) return CORRUPT;
    if (in[0] != 0x1f || in[1] != 0x8b) { *passthrough = 1; return OK; }
    if (n > MAX_IN) return TOO_LARGE;
    z_stream strm; memset(&strm, 0, sizeof strm);
    strm.next_in = (Bytef *)in; strm.avail_in = (uInt)n;
    if (inflateInit2(&strm, 16 + MAX_WBITS) != Z_OK) return CORRUPT;
    uint8_t buf[32768]; size_t total = 0; int ret = Z_OK, result = OK;
    do {
        strm.next_out = buf; strm.avail_out = sizeof buf;
        ret = inflate(&strm, Z_NO_FLUSH);
        if (ret == Z_NEED_DICT || ret == Z_STREAM_ERROR || ret == Z_DATA_ERROR || ret == Z_MEM_ERROR || ret == Z_BUF_ERROR) { result = CORRUPT; break; }
        size_t have = sizeof buf - strm.avail_out;
        if (have > 0) { if (total + have > MAX_OUT) { result = TOO_LARGE; break; } total += have; }
    } while (ret != Z_STREAM_END && strm.avail_in > 0);
    inflateEnd(&strm);
    if (result == OK && ret != Z_STREAM_END) result = CORRUPT;
    *outLen = total; return result;
}
static uint8_t *gz(const uint8_t *src, size_t n, size_t *outN) {
    z_stream s; memset(&s, 0, sizeof s);
    deflateInit2(&s, 6, Z_DEFLATED, 16 + MAX_WBITS, 8, Z_DEFAULT_STRATEGY);
    size_t cap = deflateBound(&s, n) + 64; uint8_t *o = malloc(cap);
    s.next_in = (Bytef *)src; s.avail_in = (uInt)n; s.next_out = o; s.avail_out = (uInt)cap;
    deflate(&s, Z_FINISH); *outN = s.total_out; deflateEnd(&s); return o;
}
int main(void) {
    size_t n, out; int pt;
    const char *json = "{\"code\":0,\"data\":{\"orders\":[]}}";
    uint8_t *ok = gz((const uint8_t *)json, strlen(json), &n);
    assert(gunzip(ok, n, &out, &pt) == OK && out == strlen(json) && !pt);                       // valid
    assert(gunzip((const uint8_t *)json, strlen(json), &out, &pt) == OK && pt);                  // not gzip: passthrough
    assert(gunzip(ok, n / 2, &out, &pt) == CORRUPT);                                             // truncated
    uint8_t bad[64]; memset(bad, 0xAB, sizeof bad); bad[0] = 0x1f; bad[1] = 0x8b;
    assert(gunzip(bad, sizeof bad, &out, &pt) == CORRUPT);                                       // garbage after magic
    assert(gunzip(ok, 1, &out, &pt) == CORRUPT);                                                 // too short
    size_t big = 64u * 1024u * 1024u; uint8_t *z = calloc(big, 1);                               // 64 MB zeros ("zip bomb")
    size_t bn; uint8_t *bomb = gz(z, big, &bn);
    assert(bn < MAX_IN);
    assert(gunzip(bomb, bn, &out, &pt) == TOO_LARGE && out <= MAX_OUT);                          // limit enforced before append
    size_t m4 = 3u * 1024u * 1024u; uint8_t *z3 = calloc(m4, 1); size_t n3; uint8_t *g3 = gz(z3, m4, &n3);
    assert(gunzip(g3, n3, &out, &pt) == OK && out == m4);                                        // large but allowed
    puts("PASS: gunzip logic port (valid, passthrough, truncated, garbage, short, bomb>4MB, 3MB ok)");
    return 0;
}
