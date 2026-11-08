/** Region aliases are supplied by the server; never conflate city and oblast. */
export type RegionOption={name:string;aliases?:string[];portals:number;other_services?:number;cached_schools?:number};
export function regionSearchKey(value:string):string {
 return value.normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
}
export function regionMatches(region:RegionOption,query:string):boolean {
 const tokens=regionSearchKey(query).split(' ').filter(Boolean);
 return [region.name,...(region.aliases||[])].some(name=>{
  const key=regionSearchKey(name);return tokens.every(token=>key.includes(token));
 });
}
