type ReportWindowInput={period:'7d'|'1m'|'6m'|'1y';anchor:Date;timeZone:string;disambiguation:'compatible'};
type ReportWindowResult={fromInclusive:Date;toExclusive:Date;period:string;timeZone:string;disambiguation:string};
type ReportDayWindowInput={from:string;to:string;timeZone:string;disambiguation:'compatible'};
type ReportDayWindowResult={fromInclusive:Date;toExclusive:Date;timeZone:string;disambiguation:string};

/** Same IANA check as voice `formatter()` / reportWindow; rejects offsets and Asia/Beijing. */
export function assertIanaTimeZone(timeZone:string):void{
  if(typeof timeZone!=='string'||timeZone.length<3||timeZone.length>100||!timeZone.includes('/')||timeZone.includes('+')||timeZone.toLowerCase()==='asia/beijing'){
    throw new RangeError(`Invalid IANA time zone: ${timeZone}`);
  }
  try{
    new Intl.DateTimeFormat('en-CA',{
      timeZone,calendar:'iso8601',numberingSystem:'latn',hourCycle:'h23',
      year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,
    });
  }catch{
    throw new RangeError(`Invalid IANA time zone: ${timeZone}`);
  }
}

function sharedModuleUrl(){
  return import.meta.url.endsWith('.ts')
    ? new URL('../../voice/report-window.mjs',import.meta.url)
    : new URL('../shared/report-window.mjs',import.meta.url);
}

/** Load the canonical voice calendar module in source and packaged builds. */
export async function loadReportWindow():Promise<(input:ReportWindowInput)=>ReportWindowResult>{
  const module=await import(sharedModuleUrl().href) as {reportWindow?:(input:ReportWindowInput)=>ReportWindowResult};
  if(typeof module.reportWindow!=='function')throw new Error('Shared report window module is unavailable');
  return module.reportWindow;
}

/** S22: the same module's explicit calendar-day window, used by the report date picker. */
export async function loadReportDayWindow():Promise<(input:ReportDayWindowInput)=>ReportDayWindowResult>{
  const module=await import(sharedModuleUrl().href) as {reportDayWindow?:(input:ReportDayWindowInput)=>ReportDayWindowResult};
  if(typeof module.reportDayWindow!=='function')throw new Error('Shared report window module is unavailable');
  return module.reportDayWindow;
}
