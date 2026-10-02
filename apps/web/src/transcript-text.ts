/**
 * Transcript presentation helpers.
 *
 * Stored transcripts used to hold one segment per spoken word (the provider returned word annotations), which the
 * record page rendered as one block per word with a per-word timestamp. Reading that is useless, so segments are
 * merged per track/speaker into a single readable block for display; the raw segments stay untouched in the API.
 * Both historical word-level rows and new utterance-level rows render correctly.
 */
export type TranscriptSegment={track:string;speaker?:string|null;text:string;startMs?:number|null;endMs?:number|null};
export type TranscriptBlock={track:string;speaker:string;text:string;startMs?:number};

export function transcriptTrackLabel(track:string):string{
 return track==='remote_original'?'对方原声':track==='caller_original'?'我的原声':track==='caller_playout'?'通话播放声（含补偿）':track==='caller_uplink'?'本机上行（含本机接入）':'其他声轨';
}

const NO_SPACE_BEFORE=/^[\s,.;:!?%)}\]\u3001\u3002\uff0c\uff01\uff1f\uff1b\uff1a]/u;
const NO_SPACE_AFTER=/[\s({\[\u201c\u300c\u300e\u3001\u3002\uff0c\uff01\uff1f\uff1b\uff1a]$/u;
const CJK_END=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u;
const CJK_START=/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** Joins transcript fragments with the same spacing rules the server uses for word annotations. */
export function joinTranscriptText(parts:string[]):string{
 return parts.reduce((text,part)=>{
  const word=part.trim();if(!word)return text;if(!text)return word;
  if(NO_SPACE_BEFORE.test(word)||NO_SPACE_AFTER.test(text)||(CJK_END.test(text)&&CJK_START.test(word)))return text+word;
  return `${text} ${word}`;
 },'');
}

/** Merges consecutive segments that belong to the same track and speaker into one block without per-word timing. */
export function mergeTranscriptSegments(segments:TranscriptSegment[]|undefined|null):TranscriptBlock[]{
 const blocks:TranscriptBlock[]=[];
 for(const segment of segments??[]){
  const text=typeof segment?.text==='string'?segment.text.trim():'';
  if(!text)continue;
  const speaker=segment.speaker??'';
  const previous=blocks[blocks.length-1];
  if(previous&&previous.track===segment.track&&previous.speaker===speaker){previous.text=joinTranscriptText([previous.text,text]);continue;}
  blocks.push({track:segment.track,speaker,text, ...(typeof segment.startMs==='number'?{startMs:segment.startMs}:{})});
 }
 return blocks;
}
