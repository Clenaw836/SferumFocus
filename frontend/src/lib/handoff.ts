/** Only an explicit test provider accepts OTP here; real ESIA OTP stays external. */
export function otpDigits(value:string):string{return value.replace(/[^0-9]/g,'').slice(0,6);}
export function handoffExternalUrl(value:string,origin:string):string{const u=new URL(value,origin);if(u.protocol!=='https:'&&u.origin!==origin)throw Error('Небезопасный адрес');if(u.username||u.password)throw Error('Недопустимые данные адреса');return u.href;}
