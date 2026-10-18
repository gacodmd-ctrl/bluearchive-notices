import { readFile, writeFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const ROLE_ID = '1561292516970602539';
export const SOURCES = [
  ...[['1018', '공지사항'], ['1076', '업데이트'], ['1077', '개발자 편지'],
      ['1073', '상점 안내'], ['1039', '진행 이벤트'], ['1040', '당첨 안내']]
    .map(([board, label]) => ({key: `kr-${board}`, country: '한국', board, label})),
  {key: 'jp', country: '일본', label: '공식 뉴스'},
];

export function listUrl(source, page = 1) {
  return source.board
    ? `https://forum.nexon.com/api/v1/board/${source.board}/threads?alias=bluearchive&paginationType=PAGING&pageSize=50&pageNo=${page}&blockSize=5&hideType=WEB`
    : `https://api-web.bluearchive.jp/api/news/list?typeId=0&pageNum=50&pageIndex=${page}`;
}

export function parseItems(source, data) {
  const rows = source.board ? data.threads : data.meta?.ok ? data.data?.rows : null;
  if (!Array.isArray(rows) || !rows.length) throw new Error(`${source.key}: empty or invalid official feed`);
  return rows.map(row => {
    const id = String(source.board ? row.threadId : row.id);
    const title = (source.board ? row.title : row.summary || row.title)?.trim();
    const published = Number(source.board ? row.createDate * 1000 : row.publishTime);
    if (!/^\d+$/.test(id) || !title || !Number.isFinite(published)) throw new Error(`${source.key}: invalid notice`);
    return {id, title, published, url: source.board
      ? `https://forum.nexon.com/bluearchive/board_view?board=${source.board}&thread=${id}`
      : `https://bluearchive.jp/news/newsJump/${id}`};
  });
}

export function pendingItems(items, state) {
  const seen = new Set(state.seen);
  return [...new Map(items.map(item => [item.id, item])).values()]
    .filter(item => !seen.has(item.id) && item.published >= state.startedAt)
    .sort((a, b) => a.published - b.published || Number(a.id) - Number(b.id));
}

export function payload(source, item) {
  return {
    username: '블루아카이브 공지 알림',
    content: `<@&${ROLE_ID}> ${source.country === '한국' ? '🇰🇷' : '🇯🇵'} **${source.country} 서버 새 공지**`,
    allowed_mentions: {parse: [], roles: [ROLE_ID], users: [], replied_user: false},
    embeds: [{title: item.title.slice(0, 256), url: item.url,
      color: source.country === '한국' ? 0x39a9ed : 0xf391b6,
      footer: {text: `${source.country} 공식 · ${source.label} | 원문 링크에서 상세 내용을 확인하세요`},
      timestamp: new Date(item.published).toISOString()}],
  };
}

async function getJson(url) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {headers: {'User-Agent': 'BlueArchiveNoticeRelay/1.0'}, signal: AbortSignal.timeout(20000)});
      if (!response.ok) throw new Error(`official feed HTTP ${response.status}`);
      return await response.json();
    } catch (error) { last = error; }
  }
  throw last;
}

export async function postDiscord(webhook, body, fetcher = fetch) {
  const url = new URL(webhook);
  if (url.protocol !== 'https:' || url.hostname !== 'discord.com' || !/^\/api\/webhooks\/\d+\/[^/]+$/.test(url.pathname)) {
    throw new Error('Invalid Discord webhook configuration');
  }
  url.searchParams.set('wait', 'true');
  // Do not blindly retry ambiguous network/5xx failures: Discord may already have accepted a message.
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetcher(url, {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000)});
    } catch { throw new Error('Discord delivery status uncertain; inspect channel before retrying'); }
    if (response.status === 429) {
      const data = await response.json();
      await new Promise(resolve => setTimeout(resolve, Math.min(Number(data.retry_after) * 1000 + 250, 15000)));
      continue;
    }
    if (!response.ok) throw new Error(`Discord HTTP ${response.status}`);
    const receipt = await response.json();
    if (!receipt.id) throw new Error('Discord did not return a message receipt');
    return receipt;
  }
  throw new Error('Discord rate limit: retry on next scheduled run');
}

async function save(state, file) {
  await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2) + '\n');
  await rename(`${file}.tmp`, file);
}

export async function run() {
  const preview = process.argv.includes('--preview');
  const file = process.env.STATE_FILE || 'state.json';
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!preview && !webhook) throw new Error('DISCORD_WEBHOOK_URL secret is missing');
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = {version: 1, sources: {}};
  }
  if (state.version !== 1 || !state.sources) throw new Error('Invalid saved state; refusing to reset it');
  let failed = false;
  for (const source of SOURCES) {
    try {
      const first = await getJson(listUrl(source));
      let items = parseItems(source, first);
      if (preview) {
        console.log(JSON.stringify({source: source.key, count: items.length, latest: items[0]}, null, 2));
        continue;
      }
      let saved = state.sources[source.key];
      if (!saved) {
        state.sources[source.key] = {startedAt: Date.now(), seen: items.map(item => item.id)};
        await save(state, file);
        console.log(`${source.key}: initialized; historical notices skipped`);
        continue;
      }
      if (saved.uncertain) throw new Error(`${source.key}: uncertain previous delivery requires manual review`);
      const pages = source.board ? first.totalPages : Math.ceil(first.data.count / 50);
      // Fetch up to five pages when catching up after an outage. Stop once all entries predate setup.
      for (let page = 2; page <= Math.min(pages, 5); page++) {
        if (items.every(item => item.published < saved.startedAt) || items.some(item => saved.seen.includes(item.id))) break;
        items.push(...parseItems(source, await getJson(listUrl(source, page))));
      }
      for (const item of pendingItems(items, saved)) {
        saved.uncertain = {id: item.id, url: item.url};
        await save(state, file);
        let receipt;
        try { receipt = await postDiscord(webhook, payload(source, item)); }
        catch (error) {
          // A definite 4xx (including rate limits) has not created a message and can safely retry later.
          if (/HTTP 4\d\d|rate limit/.test(error.message)) { delete saved.uncertain; await save(state, file); }
          throw error;
        }
        saved.seen.push(item.id);
        saved.lastMessageId = receipt.id;
        delete saved.uncertain;
        await save(state, file);
        console.log(`${source.key}: delivered notice ${item.id}`);
      }
      // Keep identifiers permanently; reappearing pinned notices must never trigger duplicate pings.
    } catch (error) {
      failed = true;
      console.error(`${source.key}: ${error.message}`);
    }
  }
  if (!preview && process.env.SEND_TEST === 'true' && !state.testMessageId) {
    const receipt = await postDiscord(webhook, {
      username: '블루아카이브 공지 알림',
      content: `<@&${ROLE_ID}> ✅ 한국·일본 공식 공지 알림 연결 테스트입니다.\n새 공지가 올라오면 국가·제목·원문 링크를 이 채널로 전달합니다.\n한국: https://forum.nexon.com/bluearchive/main\n일본: https://bluearchive.jp/news/\nGitHub에서 약 30분마다 확인하며, 예약 실행이 지연될 수 있습니다. 기존 공지는 일괄 발송하지 않습니다.`,
      allowed_mentions: {parse: [], roles: [ROLE_ID], users: [], replied_user: false},
    });
    state.testMessageId = receipt.id;
    await save(state, file);
    console.log('Test notification delivered');
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}
