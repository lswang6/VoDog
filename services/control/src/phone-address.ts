import {isSupportedCountry,parsePhoneNumberFromString,type CountryCode} from 'libphonenumber-js';
/** Display/grouping metadata only: never rewrite the recorded number or a queued command. */
export function smsAddress(raw:unknown,countryIso?:unknown):{conversationAddress:string;replyNumber:string|null;canReply:boolean}{
 const original=typeof raw==='string'?raw.trim():'';
 if(!original||original.length>64)return {conversationAddress:original,replyNumber:null,canReply:false};
 if(!/^[+\d().\s-]+$/.test(original))return {conversationAddress:original,replyNumber:null,canReply:false};
 const compact=original.replace(/[().\s-]/g,'');
 if(!/^\+?\d{1,20}$/.test(compact))return {conversationAddress:original,replyNumber:null,canReply:false};
 const country=typeof countryIso==='string'?countryIso.toUpperCase():'';
 const region=isSupportedCountry(country)?country as CountryCode:undefined;
 const parsed=parsePhoneNumberFromString(compact,{defaultCountry:region,extract:false});
 const address=parsed?.isValid()?parsed.number:compact;
 // Short numeric service codes remain intact; absent country information is never guessed.
 return {conversationAddress:address,replyNumber:address,canReply:true};
}

/** Digits-only match key. Never guesses a country and never rewrites the stored original. */
export function phoneDigitKey(raw:unknown):string|null{
 const original=typeof raw==='string'?raw.trim():'';
 if(!original||original.length>64)return null;
 if(!/^[+\d().\s-]+$/.test(original))return null;
 const compact=original.replace(/[().\s-]/g,'');
 if(!/^\+?\d{1,20}$/.test(compact))return null;
 const digits=compact.startsWith('+')?compact.slice(1):compact;
 return /^\d+$/.test(digits)?digits:null;
}

export function isEmergencyServiceNumber(raw:unknown):boolean{
 const key=phoneDigitKey(raw);
 return key==='112'||key==='911';
}

/**
 * Index-lookup keys for one number (S21 §A DTO enrichment).
 *
 * `phoneMatchKeys` is symmetric only because `remoteMatchesOwnerBlocklist` expands BOTH sides. A
 * `canonical_key = ANY($2)` query can expand one side only, so the national form is added here too:
 * without it a stored national key ('18600000001') would never match an incoming E.164 number
 * ('+8618600000001'), and a call would render as unblocked while the gateway still rejects it.
 *
 * `contact_phones.canonical_key` keeps the leading '+' when the number parses, `owner_blocked_numbers`
 * never does, so both spellings are emitted. Emergency numbers are never keyed.
 */
export function phoneCandidateKeys(raw:unknown,countryIso?:unknown):string[]{
 if(isEmergencyServiceNumber(raw))return [];
 const digits=new Set(phoneMatchKeys(raw,countryIso));
 const original=typeof raw==='string'?raw.trim():'';
 if(original&&original.length<=64&&/^[+\d().\s-]+$/.test(original)){
  const country=typeof countryIso==='string'?countryIso.toUpperCase():'';
  const region=isSupportedCountry(country)?country as CountryCode:undefined;
  const parsed=parsePhoneNumberFromString(original.replace(/[().\s-]/g,''),{defaultCountry:region,extract:false});
  if(parsed?.isValid()){
   const national=String(parsed.nationalNumber);
   if(/^\d{1,20}$/.test(national))digits.add(national);
  }
 }
 digits.delete('112');
 digits.delete('911');
 const keys=new Set<string>();
 for(const digit of digits){keys.add(digit);keys.add(`+${digit}`);}
 return [...keys];
}

/**
 * Match keys for owner-number equality: the digits-only form plus, when a SIM country is known,
 * the E.164 digits produced by the same smsAddress rules. Country is never guessed.
 */
export function phoneMatchKeys(raw:unknown,countryIso?:unknown):string[]{
 const keys=new Set<string>();
 const digits=phoneDigitKey(raw);
 if(digits)keys.add(digits);
 const addressed=smsAddress(raw,countryIso);
 const addressedKey=phoneDigitKey(addressed.conversationAddress);
 if(addressedKey)keys.add(addressedKey);
 keys.delete('112');
 keys.delete('911');
 return [...keys];
}
