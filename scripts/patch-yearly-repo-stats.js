const fs = require('node:fs');

const GRAPHQL_ENDPOINT =
    process.env.GITHUB_ENDPOINT || 'https://api.github.com/graphql';
const REST_ENDPOINT = process.env.GITHUB_REST_ENDPOINT || 'https://api.github.com';
const PER_PAGE = 100;

const STAR_ICON =
    'M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279';
const FORK_ICON =
    'M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25';

const toScale = (value) => {
    if (value <= 9999) {
        return value.toFixed(0);
    }
    if (value <= 999999) {
        return `${Math.floor(value / 1000).toFixed(0)}K`;
    }
    return '1M+';
};

const isInYear = (timestamp, year) => {
    const date = new Date(timestamp);
    return date.getUTCFullYear() === year;
};

const requestJson = async (fetchImpl, url, options) => {
    const response = await fetchImpl(url, options);
    if (!response.ok) {
        throw new Error(
            `GitHub request failed: ${response.status} ${response.statusText} ${url}`,
        );
    }
    return response.json();
};

const authHeaders = (token, extraHeaders = {}) => ({
    Authorization: `bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    ...extraHeaders,
});

const listOwnedRepositories = async ({ fetchImpl, token, username }) => {
    const repositories = [];
    let cursor = null;

    do {
        const response = await requestJson(fetchImpl, GRAPHQL_ENDPOINT, {
            method: 'POST',
            headers: authHeaders(token, {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            }),
            body: JSON.stringify({
                query: `
                    query($login: String!, $cursor: String) {
                        user(login: $login) {
                            repositories(
                                first: 100,
                                after: $cursor,
                                ownerAffiliations: OWNER
                            ) {
                                pageInfo {
                                    hasNextPage
                                    endCursor
                                }
                                nodes {
                                    nameWithOwner
                                }
                            }
                        }
                    }
                `.replace(/\s+/g, ' '),
                variables: { login: username, cursor },
            }),
        });

        if (response.errors && response.errors.length) {
            throw new Error(response.errors[0].message);
        }
        const page = response.data?.user?.repositories;
        if (!page) {
            throw new Error(`Could not load repositories for ${username}`);
        }

        repositories.push(...page.nodes.map((node) => node.nameWithOwner));
        cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);

    return repositories;
};

const repoApiUrl = (nameWithOwner, resource, page) => {
    const [owner, repo] = nameWithOwner.split('/');
    return (
        `${REST_ENDPOINT}/repos/${encodeURIComponent(owner)}/` +
        `${encodeURIComponent(repo)}/${resource}?per_page=${PER_PAGE}&page=${page}`
    );
};

const countPagedRepoEvents = async ({
    fetchImpl,
    token,
    nameWithOwner,
    resource,
    timestampField,
    year,
    accept,
}) => {
    let count = 0;
    let page = 1;

    while (true) {
        const events = await requestJson(
            fetchImpl,
            repoApiUrl(nameWithOwner, resource, page),
            {
                headers: authHeaders(token, { Accept: accept }),
            },
        );

        count += events.filter((event) => isInYear(event[timestampField], year))
            .length;

        if (events.length < PER_PAGE) {
            return count;
        }
        page += 1;
    }
};

const collectYearlyRepoStats = async ({
    fetchImpl = fetch,
    token,
    username,
    year,
}) => {
    const repositories = await listOwnedRepositories({ fetchImpl, token, username });
    let stars = 0;
    let forks = 0;

    for (const nameWithOwner of repositories) {
        stars += await countPagedRepoEvents({
            fetchImpl,
            token,
            nameWithOwner,
            resource: 'stargazers',
            timestampField: 'starred_at',
            year,
            accept: 'application/vnd.github.star+json',
        });
        forks += await countPagedRepoEvents({
            fetchImpl,
            token,
            nameWithOwner,
            resource: 'forks',
            timestampField: 'created_at',
            year,
            accept: 'application/vnd.github+json',
        });
    }

    return { stars, forks };
};

const patchStatValue = (svg, iconNeedle, value, label) => {
    const iconIndex = svg.indexOf(iconNeedle);
    if (iconIndex === -1) {
        throw new Error(`Could not find ${label} stats icon`);
    }

    const iconGroupEnd = svg.indexOf('</g>', iconIndex);
    if (iconGroupEnd === -1) {
        throw new Error(`Could not isolate ${label} stats icon group`);
    }

    const valueStart = iconGroupEnd + '</g>'.length;
    const remaining = svg.slice(valueStart);
    const valueMatch = remaining.match(
        /^(\s*<text\b[^>]*>)([^<]+)(<title>)([^<]+)(<\/title><\/text>)/,
    );
    if (!valueMatch) {
        throw new Error(`Could not find ${label} stats value`);
    }

    const displayValue = toScale(value);
    const replacement = `${valueMatch[1]}${displayValue}${valueMatch[3]}${value}${valueMatch[5]}`;

    return (
        svg.slice(0, valueStart) +
        remaining.replace(valueMatch[0], replacement)
    );
};

const patchRepoStats = (svg, stats) => {
    const withStars = patchStatValue(svg, STAR_ICON, stats.stars, 'star');
    return patchStatValue(withStars, FORK_ICON, stats.forks, 'fork');
};

const patchFiles = (filePaths, stats) => {
    for (const filePath of filePaths) {
        const svg = fs.readFileSync(filePath, 'utf8');
        fs.writeFileSync(filePath, patchRepoStats(svg, stats));
    }
};

const parseArgs = (args) => {
    const [yearArg, ...filePaths] = args;
    const year = Number(yearArg);
    if (!yearArg || Number.isNaN(year) || !Number.isInteger(year)) {
        throw new Error(
            'Usage: node scripts/patch-yearly-repo-stats.js <year> <svg> [svg...]',
        );
    }
    if (filePaths.length === 0) {
        throw new Error(
            'Usage: node scripts/patch-yearly-repo-stats.js <year> <svg> [svg...]',
        );
    }
    return { year, filePaths };
};

const main = async () => {
    const { year, filePaths } = parseArgs(process.argv.slice(2));
    const token = process.env.GITHUB_TOKEN;
    const username = process.env.USERNAME;

    if (!token) {
        throw new Error('GITHUB_TOKEN is empty');
    }
    if (!username) {
        throw new Error('USERNAME is empty');
    }

    const stats = await collectYearlyRepoStats({ token, username, year });
    patchFiles(filePaths, stats);
    console.log(
        `Patched ${filePaths.length} SVG(s) for ${year}: ${stats.stars} stars, ${stats.forks} forks`,
    );
};

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    collectYearlyRepoStats,
    patchFiles,
    patchRepoStats,
    toScale,
};
