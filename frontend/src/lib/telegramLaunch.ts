/** Launch credentials stay in memory only. SPA navigation must not erase the URL fallback. */
export function createTelegramReader(sdk:()=>string, hash:()=>string):()=>string {
  let launchFragment='';
  return ()=>{
    const currentHash=hash();
    if(currentHash)launchFragment=currentHash;
    return sdk()||currentHash||launchFragment;
  };
}
/** Compare equivalent URL transports, not parsed/re-serialized user JSON. Never verifies identity.
 *  v2.1: MAX тоже сравнивается канонически. Мост MAX и фрагмент #WebAppData отдают одну и ту же подпись
 *  в разной кодировке (A+B / A%20B, другой порядок полей) — раньше это считалось «новым входом» и
 *  перезагружало приложение (а перезагрузка в слабой сети заканчивалась экраном таймаута). */
export function sameCredential(a:string,b:string):boolean {
  if(a===b)return true;
  const tg=a.startsWith('telegram:');
  if(tg!==b.startsWith('telegram:'))return false;
  const parse=(raw:string):[string,string][]|null=>{
    const text=tg?raw.slice(9):raw;if(!text||/%(?![0-9a-f]{2})/i.test(text))return null;
    const pairs=[...new URLSearchParams(text)];
    if(!pairs.length||new Set(pairs.map(([k])=>k)).size!==pairs.length)return null;
    return pairs;
  };
  const x=parse(a),y=parse(b);if(!x||!y)return false;
  const canonical=(pairs:[string,string][])=>JSON.stringify([...pairs].sort(([p],[q])=>p<q?-1:p>q?1:0));
  return canonical(x)===canonical(y);
}
