export // proc 0: GENERIC helper
function encode_proc0(s0: number): number {
    let s1;
    s1 = 0;
    switch (s0) {
        case 0: {
            s1 = 100;
            break
        }
        case 1: {
            s1 = ((s1) + (7)) >>> 0;
            break
        }
        case 2: {
            s1 = 200;
            s1 = ((s1) + (7)) >>> 0;
            break
        }
        default: {
            s1 = ((s1) + (7)) >>> 0;
            break
        }
    }
    return s1;
}