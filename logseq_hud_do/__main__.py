"""JSON command-line interface."""
import argparse
import json
import os
from pathlib import Path
import sys
import sqlite3
from .backend import scan, block_context


def main():
    parser = argparse.ArgumentParser(description='Read-only Logseq task index')
    parser.add_argument('--graph', action='append', required=True, metavar='PATH')
    parser.add_argument('--graph-name', action='append', default=[], metavar='NAME', help='display names in graph argument order')
    parser.add_argument('--cache', default=str(Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache')) / 'logseq-hud-do' / 'tasks.sqlite3'))
    parser.add_argument('--horizon', type=int, default=7)
    parser.add_argument('--full-rescan', action='store_true')
    parser.add_argument('--diagnostics', action='store_true')
    parser.add_argument('--block-context', nargs=2, metavar=('SOURCE_FILE', 'BLOCK'),
                        help='print parent/current/children JSON for a block in one graph and exit')
    args = parser.parse_args()
    try:
        if len(args.graph_name) > len(args.graph):
            raise ValueError('more graph names than graphs')
        graphs = [(path, args.graph_name[i] if i < len(args.graph_name) else None) for i, path in enumerate(args.graph)]
        if args.block_context is not None:
            if len(args.graph) != 1:
                raise ValueError('--block-context requires exactly one --graph')
            source_file, target = args.block_context
            path, name = graphs[0]
            resolved = Path(path).expanduser().resolve()
            context = block_context(resolved, source_file, target, name=name)
            print(json.dumps(context, ensure_ascii=False))
            return 0
        result, diagnostics = scan(graphs, args.cache, full_rescan=args.full_rescan, horizon=args.horizon)
        print(json.dumps(result, ensure_ascii=False))
        if args.diagnostics:
            print(json.dumps(diagnostics), file=sys.stderr)
        return 0
    except (OSError, ValueError, sqlite3.Error) as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
