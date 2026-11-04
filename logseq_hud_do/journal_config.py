"""Read the supported journal setting without evaluating graph configuration."""
import json

DEFAULT_TITLE_FORMAT = 'MMM do, yyyy'
DATE_FORMATS = {
    'MM/dd/yyyy': '%m/%d/%Y', 'MM-dd-yyyy': '%m-%d-%Y',
    'MM_dd_yyyy': '%m_%d_%Y', 'yyyy/MM/dd': '%Y/%m/%d',
    'yyyy-MM-dd': '%Y-%m-%d', 'yyyy_MM_dd': '%Y_%m_%d',
    'yyyy年MM月dd日': '%Y年%m月%d日',
}
TITLE_FORMATS = {DEFAULT_TITLE_FORMAT, 'yyyy-MM-dd, EEE', *DATE_FORMATS,
                 *(prefix + ', ' + date for prefix in ('E', 'EEE', 'EEEE')
                   for date in ('MM/dd/yyyy', 'yyyy/MM/dd'))}
WEEKDAYS = ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday')


def validate_format(pattern, supported, setting):
    if pattern is not None and (not isinstance(pattern, str) or pattern not in supported):
        raise ValueError(f'unsupported {setting}: {pattern!r}')


def journal_title(day, pattern):
    if pattern == DEFAULT_TITLE_FORMAT:
        suffix = 'th' if 10 <= day.day % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(day.day % 10, 'th')
        month = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split()[day.month - 1]
        return f'{month} {day.day}{suffix}, {day.year}'
    weekday = WEEKDAYS[day.weekday()]
    if pattern == 'yyyy-MM-dd, EEE':
        return f'{day.isoformat()}, {weekday[:3]}'
    if pattern in DATE_FORMATS:
        return day.strftime(DATE_FORMATS[pattern])
    prefix, date = pattern.split(', ')
    return (weekday if prefix == 'EEEE' else weekday[:3]) + ', ' + day.strftime(DATE_FORMATS[date])


def journal_format(text, setting_key=':journal/page-title-format'):
    """Read a top-level setting; missing keys or malformed EDN return None."""
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
            value, end = json.JSONDecoder(strict=False).raw_decode(text[position:])
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
            if key == ('atom', setting_key):
                setting = value[1] if value[0] == 'string' else value
        return setting
    except (ValueError, IndexError, RecursionError):
        return None
