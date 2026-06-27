const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    collectYearlyRepoStats,
    patchRepoStats,
    toScale,
} = require('../scripts/patch-yearly-repo-stats');

const STAR_ICON =
    'M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279';
const FORK_ICON =
    'M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25';

const makeSvg = () =>
    [
        '<svg>',
        '<g>',
        '<text style="font-size: 32px;">126</text>',
        '<text style="font-size: 24px;">contributions</text>',
        `<g transform="translate(608, 802), scale(2)"><path d="${STAR_ICON}" class="fill-fg"></path></g>`,
        '<text style="font-size: 32px;" x="650">16<title>16</title></text>',
        `<g transform="translate(736, 802), scale(2)"><path d="${FORK_ICON}" class="fill-fg"></path></g>`,
        '<text style="font-size: 32px;" x="772">4<title>4</title></text>',
        '<text style="font-size: 16px;">2026-01-01 / 2026-12-31</text>',
        '</g>',
        '</svg>',
    ].join('');

const jsonResponse = (body) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: async () => body,
});

test('profile renders and generates only the current contribution chart', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const readRepoFile = (filePath) =>
        fs.readFileSync(path.join(repoRoot, filePath), 'utf8');

    const readme = readRepoFile('README.md');
    const workflow = readRepoFile('.github/workflows/profile-3d-contrib.yml');

    assert.equal(readme.includes('2025 Contributions'), false);
    assert.equal(readme.includes('2025-day.svg'), false);
    assert.equal(readme.includes('2025-night.svg'), false);
    assert.equal(workflow.includes('github-profile-2025.json'), false);
    assert.equal(workflow.includes('YEAR: 2025'), false);
    assert.equal(workflow.includes('patch-yearly-repo-stats.js 2025'), false);
    assert.equal(
        fs.existsSync(path.join(repoRoot, 'conf/github-profile-2025.json')),
        false,
    );
    assert.equal(workflow.includes('YEAR: 2026'), false);
    assert.match(workflow, /CURRENT_YEAR=\$\(date -u \+%Y\)/);
    assert.match(
        workflow,
        /patch-yearly-repo-stats\.js \"\$CURRENT_YEAR\" profile-3d-contrib\/day\.svg profile-3d-contrib\/night\.svg/,
    );
    assert.match(readme, /Current Contributions/);
});

test('patches star and fork values without removing icons or year-specific contribution data', () => {
    const patched = patchRepoStats(makeSvg(), { stars: 3, forks: 1 });

    assert.equal(patched.includes(STAR_ICON), true);
    assert.equal(patched.includes(FORK_ICON), true);
    assert.equal(patched.includes('>16<title>16</title></text>'), false);
    assert.equal(patched.includes('>4<title>4</title></text>'), false);
    assert.match(patched, />3<title>3<\/title><\/text>/);
    assert.match(patched, />1<title>1<\/title><\/text>/);
    assert.match(patched, />126<\/text>/);
    assert.match(patched, />contributions<\/text>/);
    assert.match(patched, />2026-01-01 \/ 2026-12-31<\/text>/);
});

test('collects repository stars and forks created during the selected year', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        if (url === 'https://api.github.com/graphql') {
            return jsonResponse({
                data: {
                    user: {
                        repositories: {
                            pageInfo: {
                                hasNextPage: false,
                                endCursor: null,
                            },
                            nodes: [
                                { nameWithOwner: 'junkey/alpha' },
                                { nameWithOwner: 'junkey/beta' },
                            ],
                        },
                    },
                },
            });
        }
        if (url.includes('/repos/junkey/alpha/stargazers')) {
            return jsonResponse([
                { starred_at: '2026-01-05T00:00:00Z' },
                { starred_at: '2027-01-05T00:00:00Z' },
            ]);
        }
        if (url.includes('/repos/junkey/beta/stargazers')) {
            return jsonResponse([{ starred_at: '2026-12-31T23:59:59Z' }]);
        }
        if (url.includes('/repos/junkey/alpha/forks')) {
            return jsonResponse([
                { created_at: '2025-12-31T23:59:59Z' },
                { created_at: '2026-07-10T00:00:00Z' },
            ]);
        }
        if (url.includes('/repos/junkey/beta/forks')) {
            return jsonResponse([{ created_at: '2026-03-01T00:00:00Z' }]);
        }
        throw new Error(`Unexpected URL: ${url}`);
    };

    const stats = await collectYearlyRepoStats({
        fetchImpl,
        token: 'token',
        username: 'junkey',
        year: 2026,
    });

    assert.deepEqual(stats, { stars: 2, forks: 2 });
    assert.equal(calls.length, 5);
    assert.equal(
        calls.some((call) =>
            call.options.headers.Accept.includes(
                'application/vnd.github.star+json',
            ),
        ),
        true,
    );
});

test('scales large displayed values like the upstream generator', () => {
    assert.equal(toScale(9999), '9999');
    assert.equal(toScale(10000), '10K');
    assert.equal(toScale(999999), '999K');
    assert.equal(toScale(1000000), '1M+');
});
