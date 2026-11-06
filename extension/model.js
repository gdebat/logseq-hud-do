export const statuses = ['TODO', 'DOING'];
export const sections = ['today', 'overdue', 'upcoming'];
export const priorities = {A: ['High', 'high'], B: ['Medium', 'medium'], C: ['Low', 'low']};

const priorityMarker = new RegExp(`\\[#(?:${Object.keys(priorities).join('|')})\\]`, 'g');
export const hiddenRegistryVersion = 2;

export function backendArguments(directory, graphs, horizon) {
    if (!graphs.length)
        throw new Error('Add a Logseq graph in Preferences.');
    const args = ['python3', '-m', 'logseq_hud_do', '--horizon', String(horizon)];
    for (const [path, name] of graphs) {
        if (!path.startsWith('/'))
            throw new Error('Graph directories must be absolute paths.');
        args.push(`--graph=${path}`, `--graph-name=${name || path.split('/').filter(Boolean).pop()}`);
    }
    return {args, directory};
}

// Build a one-shot backend invocation for a single block's context. The backend
// prints a JSON object and exits; no persistent process or IPC channel exists
// (requirements.md forbids a background service). The task already carries its
// graph path, display name, source file and identity from the task list.
export function blockContextArguments(directory, task) {
    if (typeof task.graph_path !== 'string' || !task.graph_path.startsWith('/'))
        throw new Error('Task is missing a graph directory.');
    if (typeof task.source_file !== 'string' || !task.source_file ||
        task.source_file.startsWith('/') || task.source_file.split('/').includes('..'))
        throw new Error('Task is missing a valid source file.');
    if (typeof task.id !== 'string' || !task.id)
        throw new Error('Task is missing a block identity.');
    const args = ['python3', '-m', 'logseq_hud_do',
        `--graph=${task.graph_path}`, `--graph-name=${task.graph || task.graph_path.split('/').filter(Boolean).pop()}`,
        '--block-context', task.source_file, task.id];
    return {args, directory};
}

function validBlock(block) {
    return block && typeof block === 'object' &&
        typeof block.content === 'string' &&
        (block.uuid === null || typeof block.uuid === 'string');
}

export function parseBlockContext(stdout) {
    const data = JSON.parse(stdout);
    if (!data || typeof data !== 'object' ||
        !Array.isArray(data.parent) || !Array.isArray(data.children) ||
        !validBlock(data.current) || !data.parent.every(validBlock) ||
        !data.children.every(validBlock))
        throw new Error('Invalid block context response.');
    return {parent: data.parent, current: data.current, children: data.children};
}

export function parseTasks(stdout) {
    const data = JSON.parse(stdout);
    for (const section of sections) {
        if (!Array.isArray(data[section]))
            throw new Error('Invalid backend response.');
        for (const task of data[section]) {
            if (typeof task.content !== 'string' || typeof task.graph !== 'string' ||
                typeof task.source_page !== 'string' ||
                typeof task.graph_path !== 'string' || !task.graph_path.startsWith('/') ||
                !statuses.includes(task.status) ||
                (task.priority !== null && !Object.hasOwn(priorities, task.priority)) ||
                (task.scheduled !== null && typeof task.scheduled !== 'string') ||
                (task.deep_link !== null && typeof task.deep_link !== 'string'))
                throw new Error('Invalid backend task.');
        }
    }
    return data;
}

export const defaultBlockFilters = [[':LOGBOOK:', ':END:']];

export const defaultTextFilters = ['^[ \t]*relay-id::'];

// Anchoring and a single repetition keep matching linear in the line length.
export function compileTextFilter(pattern) {
    if (pattern.length > 256 || !pattern.startsWith('^'))
        throw new Error('Use ^ at the start and at most 256 characters.');
    let repetitions = 0;
    for (let i = 1; i < pattern.length; i++) {
        const char = pattern[i];
        if (char === '\\') {
            if (!pattern[++i] || !'dDsSwW\\.^$*+?()[]{}|-'.includes(pattern[i]))
                throw new Error('Unsupported escape.');
        } else if (char === '[') {
            const start = ++i;
            while (i < pattern.length && pattern[i] !== ']') {
                if (pattern[i] === '\\') i++;
                i++;
            }
            if (i === start || i === pattern.length)
                throw new Error('Invalid character class.');
        } else if ('*+'.includes(char)) {
            if (++repetitions > 1)
                throw new Error('Use at most one * or + repetition.');
        } else if ('(){}|?^'.includes(char)) {
            throw new Error('Groups, alternatives, counts and optional matches are unsupported.');
        }
    }
    return new RegExp(pattern);
}

function filterBlocks(lines, blocks) {
    const endings = new Map();
    for (const [start, end] of blocks) {
        if (start.trim() && end.trim() && !endings.has(start.trim()))
            endings.set(start.trim(), end.trim());
    }
    const result = [];
    let opening = -1;
    let closing = null;
    for (let i = 0; i < lines.length; i++) {
        const marker = lines[i].text.trim();
        if (opening >= 0) {
            if (marker === closing) {
                opening = -1;
                closing = null;
            }
        } else if (endings.has(marker)) {
            opening = i;
            closing = endings.get(marker);
        } else {
            result.push(lines[i]);
        }
    }
    if (opening >= 0)
        for (let i = opening; i < lines.length; i++)
            result.push(lines[i]);
    return result;
}

export function displayContent(content, patterns = defaultTextFilters, blocks = defaultBlockFilters) {
    const filters = patterns.flatMap(pattern => {
        try { return [compileTextFilter(pattern)]; } catch { return []; }
    });
    const lines = content.split(/\r?\n/).map((text, index) => ({text, index}));
    return filterBlocks(lines, blocks)
        .filter(({text}) => !filters.some(filter => filter.test(text)))
        .map(({text, index}) => index === 0
            ? text.replace(new RegExp(`${priorityMarker.source}[ \t]*`, 'g'), '') : text)
        .join('\n').trim();
}

export function taskPresentation(task, patterns = defaultTextFilters, blocks = defaultBlockFilters) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const scheduled = task.scheduled ? task.scheduled.split('-') : null;
    const context = scheduled
        ? `${task.graph} · ${Number(scheduled[2])} ${months[Number(scheduled[1]) - 1]} ${scheduled[0]}`
        : task.graph;
    return {
        content: displayContent(task.content, patterns, blocks),
        doing: task.status === 'DOING',
        priority: priorities[task.priority] ?? null,
        context,
        uri: typeof task.deep_link === 'string' && task.deep_link.startsWith('logseq://graph/')
            ? task.deep_link : null,
    };
}

// A settings change during a scan must get a fresh scan after that process exits.
export class RefreshController {
    constructor(run, publish, fail) {
        this.run = run;
        this.publish = publish;
        this.fail = fail;
        this.active = false;
        this.pending = false;
        this.closed = false;
    }

    async refresh(invalidate = false) {
        if (this.closed)
            return;
        if (this.active) {
            this.pending = true;
            this.obsolete ||= invalidate;
            return;
        }
        this.active = true;
        this.obsolete = false;
        try {
            const data = await this.run();
            if (!this.closed && !this.obsolete)
                this.publish(data);
        } catch (error) {
            if (!this.closed && !this.obsolete)
                this.fail(error.message);
        } finally {
            this.active = false;
            if (this.pending && !this.closed) {
                this.pending = false;
                this.refresh();
            }
        }
    }

    close() {
        this.closed = true;
        this.pending = false;
    }
}

export function logicalIdentity(task) {
    if (typeof task.graph_path !== 'string' || !task.graph_path.startsWith('/'))
        throw new Error('Missing stable graph identity.');
    const text = task.content.split(/\r?\n/)
        .map((line, index) => index === 0 ? line.replace(priorityMarker, '') : line)
        .map(line => line.replace(/[ \t]+/g, ' ').trim()).join('\n').trim();
    return JSON.stringify([task.graph_path, task.source_page, text, task.scheduled]);
}

const hiddenRecordFields = {
    key: {value: (_task, key) => key, valid: value => typeof value === 'string'},
    description: {value: (_task, key) => JSON.parse(key)[2], valid: value => typeof value === 'string'},
    graph: {value: task => task.graph, valid: value => typeof value === 'string'},
    scheduled: {value: task => task.scheduled, valid: value => value === null || typeof value === 'string'},
};

function validHiddenRecord(record) {
    if (!record || !Object.entries(hiddenRecordFields).every(([field, contract]) => contract.valid(record[field])))
        return false;
    try {
        const key = JSON.parse(record.key);
        return Array.isArray(key) && key.length === 4 &&
            typeof key[0] === 'string' && key[0].startsWith('/') &&
            typeof key[1] === 'string' && typeof key[2] === 'string' &&
            key[2] === record.description && key[3] === record.scheduled;
    } catch {
        return false;
    }
}

function readRegistry(settings) {
    let registry;
    try {
        registry = JSON.parse(settings.get_string('hidden-tasks-v2'));
    } catch {
        throw new Error('Hidden tasks could not be read. No changes were saved. Use confirmed Unhide All in Preferences to reset the registry.');
    }
    if (!registry || registry.version !== hiddenRegistryVersion || !Array.isArray(registry.tasks))
        throw new Error('Hidden tasks have an invalid or unsupported format. No changes were saved. Use confirmed Unhide All in Preferences to reset the registry.');
    return registry;
}

export function readHidden(settings) {
    try {
        return readRegistry(settings).tasks.filter(validHiddenRecord);
    } catch {
        return [];
    }
}

function editHidden(settings, key, replacement) {
    const registry = readRegistry(settings);
    const matching = record => validHiddenRecord(record) && record.key === key;
    if (!replacement && registry.tasks.some(record => matching(record) &&
        Object.keys(record).some(field => !Object.hasOwn(hiddenRecordFields, field))))
        throw new Error('This hidden task contains unknown fields. No changes were saved. Use confirmed Unhide All in Preferences to reset the registry.');
    const exists = registry.tasks.some(matching);
    registry.tasks = registry.tasks.flatMap(record => matching(record)
        ? replacement ? [{...record, ...replacement}] : [] : [record]);
    if (replacement && !exists)
        registry.tasks.push(replacement);
    if (settings.set_string('hidden-tasks-v2', JSON.stringify(registry)) === false)
        throw new Error('Hidden tasks could not be saved. Check that the settings are writable and try again.');
}

export function unhideTask(settings, key) {
    editHidden(settings, key);
}

export function writeHidden(settings, tasks) {
    if (settings.set_string('hidden-tasks-v2', JSON.stringify({version: hiddenRegistryVersion, tasks})) === false)
        throw new Error('Hidden tasks could not be saved. Check that the settings are writable and try again.');
}

export function hideTask(settings, task) {
    const key = logicalIdentity(task);
    editHidden(settings, key, Object.fromEntries(Object.entries(hiddenRecordFields)
        .map(([field, contract]) => [field, contract.value(task, key)])));
}

export function visibleTasks(data, settings) {
    const hidden = new Set(readHidden(settings).map(record => record.key));
    return Object.fromEntries(sections.map(section => [section,
        data[section].filter(task => !hidden.has(logicalIdentity(task)))]));
}
