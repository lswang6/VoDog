/** S87: links in SMS bodies. The pattern is the cross-platform contract in docs/specs/S87 — keep it literal. */
const LINK=String.raw`https?://[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+|(?<![@A-Za-z0-9.\-/:])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+(?:com|cn|net|org|top|xyz|cc|vip|info|me|io|co|app|shop|link)(?![A-Za-z0-9-])(?::\d+)?(?:/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]*)?`;

export type SmsSegment={text:string;url?:string};

export function smsLinkSegments(body:string):SmsSegment[]{
 const segments:SmsSegment[]=[];let last=0;
 for(const match of body.matchAll(new RegExp(LINK,'gi'))){
  const text=match[0].replace(/[.,;:!?'")\]}*]+$/,'');
  if(!text||/^https?:\/\/$/i.test(text))continue;
  const start=match.index!;
  if(start>last)segments.push({text:body.slice(last,start)});
  segments.push({text,url:/^https?:\/\//i.test(text)?text:'http://'+text});
  last=start+text.length;
 }
 if(last<body.length)segments.push({text:body.slice(last)});
 return segments;
}

/** SMS text is untrusted: only http(s) ever reaches window.open. */
export function isOpenableUrl(url:string){
 try{const {protocol}=new URL(url);return protocol==='http:'||protocol==='https:';}catch{return false;}
}
