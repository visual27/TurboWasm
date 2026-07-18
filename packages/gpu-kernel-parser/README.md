# @turbowasm/gpu-kernel-parser

Parser and formatter for the TurboWasm `@compute` kernel DSL. Used by the
`gpu-compute-dsl` VSCode extension to syntax-highlight, complete, hover,
diagnose, and format `.scgpu` files.

This package is a **plain re-export** of the parser logic that ships inside
the TurboWasm Viewer (`src/runtime/gpu-kernel/comment-parser.ts`). The
Viewer and the parser package are kept in lock-step: when the Viewer's
parser is updated, this package is updated at the same time. The parser
behaviour is intentionally identical to the in-tree parser —
`test/comment-parser.test.ts` verifies the source files byte-for-byte.

## Quoted names

`@bind` and `@map` accept double-quoted names containing spaces or
punctuation. `\"` and `\\` escape quotes and backslashes; other escaped
characters keep the character and discard the backslash.

```text
@bind "my list"(0) rw f32
@map "output index" <- R0
```

Parsed directives preserve the Scratch name in `name` or `var` and include
a WGSL-safe `internalName` in `__tw_<hash>` form.

## API surface

| Export                       | Description                                  |
| ---------------------------- | -------------------------------------------- |
| `parseComputeComment`        | Parse a single `@compute` comment text.      |
| `parseScgpuDocument`         | Parse a full `.scgpu` document.              |
| `formatScratchComment`       | Prefix every line for Scratch comment paste. |
| `formatScgpuDocument`        | Sort directives and tidy whitespace.         |
| `DIRECTIVE_HEADS`            | List of known directive names.               |
| `ALL_AXES`, `KNOWN_AXES`     | Reserved axis names.                         |
| `BIND_DTYPES`                | Valid `@bind` dtype tokens.                  |
| Types                        | `Severity`, `Diagnostic`, directive types.   |

## License

GPL-3.0-only.
