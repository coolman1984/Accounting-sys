"""Insert TypeScript object text into a nested block of en.ts / ar.ts, found by key path."""
LOC = '/home/user/Accounting-sys/apps/web/src/core/locales/'

def _block_end(s, start):
    """Index of the '}' closing the '{' at s[start]."""
    depth = 0; i = start; q = None
    while i < len(s):
        ch = s[i]
        if q:
            if ch == '\\': i += 2; continue
            if ch == q: q = None
        elif ch in "'\"`": q = ch
        elif ch == '{': depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0: return i
        i += 1
    raise ValueError('unbalanced')

def find_block(s, path):
    """(open, close) of the object at key path, e.g. ['errors', 'payroll']."""
    lo, hi = s.index('= {') + 2, None
    hi = _block_end(s, lo)
    for depth, key in enumerate(path):
        indent = '  ' * (depth + 1)
        needle = f'\n{indent}{key}: {{'
        i = s.index(needle, lo, hi)
        lo = i + len(needle) - 1
        hi = _block_end(s, lo)
    return lo, hi

def insert(file, path, text, create=False):
    p = LOC + file
    s = open(p).read()
    try:
        lo, hi = find_block(s, path)
    except ValueError:
        if not create: raise
        lo, hi = find_block(s, path[:-1])
        indent = '  ' * len(path)
        text = f"\n{indent}{path[-1]}: {{{text}\n{indent}}},"
        s = s[:hi].rstrip() + text + '\n' + '  ' * (len(path) - 1) + s[hi:]
        open(p, 'w').write(s); return
    head = s[:hi].rstrip()
    if not head.endswith((',', '{')): head += ','
    s = head + text + '\n' + '  ' * len(path) + s[hi:]
    open(p, 'w').write(s)

def both(path, en, ar, create=False):
    insert('en.ts', path, en, create)
    insert('ar.ts', path, ar, create)
