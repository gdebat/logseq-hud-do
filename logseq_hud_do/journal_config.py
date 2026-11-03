"""Read the supported journal setting without evaluating graph configuration."""
import json

CUSTOM_FORMAT = 'yyyy-MM-dd, EEE'


def journal_format(text):
    """Read a top-level EDN map; unsupported or malformed input uses defaults."""
    position = 0
    discarded = object()

    def whitespace():
        nonlocal position
        while position < len(text):
            if text[position].isspace() or text[position] == ',':
                position += 1
            elif text[position] == ';':
                end = text.find('\n', position)
                position = len(text) if end < 0 else end + 1
            else:
                break

    def form(as_set=False):
        nonlocal position
        whitespace()
        if position == len(text):
            raise ValueError('missing form')
        char = text[position]
        position += 1
        if char == '"':
            position -= 1
            value, end = json.JSONDecoder().raw_decode(text[position:])
            position += end
            return ('string', value)
        if char in '{[(':
            closing = {'{': '}', '[': ']', '(': ')'}[char]
            values = []
            while True:
                whitespace()
                if position == len(text):
                    raise ValueError('unclosed collection')
                if text[position] == closing:
                    position += 1
                    break
                value = form()
                if value is not discarded:
                    values.append(value)
            if char == '{' and not as_set and len(values) % 2:
                raise ValueError('odd map')
            return (char, values)
        if char in '}])':
            raise ValueError('unexpected delimiter')
        if char == '#' and position < len(text):
            if text[position] == '_':
                position += 1
                operand()
                return discarded
            if text[position] == '{':
                return ('set', form(True))
        start = position - 1
        if char == '\\':
            if position == len(text):
                raise ValueError('missing character')
            position += 1
        while position < len(text) and not text[position].isspace() and text[position] not in ',;{}[]()"':
            position += 1
        token = text[start:position]
        if token.startswith('#'):
            return ('tag', (token, operand()))
        return ('atom', token)

    def operand():
        value = form()
        while value is discarded:
            value = form()
        return value

    try:
        root = operand()
        whitespace()
        if position != len(text) or root[0] != '{':
            return None
        values = root[1]
        setting = None
        for key, value in zip(values[::2], values[1::2]):
            if key == ('atom', ':journal/page-title-format'):
                setting = value[1] if value[0] == 'string' else None
        return setting
    except (ValueError, IndexError, RecursionError):
        return None
