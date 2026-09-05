export // proc 0: GENERIC helper
function encode_proc0(s0: number): number {
    let s1, s2;
    s1 = 0;
    s2 = 0;
    for (;;) {
        if (!(((s2) < (s0) ? 1 : 0))) break
        s1 = ((s1) + (1)) >>> 0;
        s2 = ((s2) + (1)) >>> 0;
    }
    return s1;
}