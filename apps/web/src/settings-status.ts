export type SettingsSnapshot={version:number;appliedVersion:number|null};
export type SettingsSubmission={target:number;fresh:boolean;timedOut?:boolean};

/** S80：与 iOS SettingsApplyPolicy.swift 同一套文案。 */
export function settingsStatus(settings:SettingsSnapshot,submission?:SettingsSubmission|null):string{
 if(!submission)return settings.appliedVersion===settings.version?'设备已确认当前设置':'设置已保存，但设备尚未确认应用。';
 if(!submission.fresh)return '正在应用中…';
 if(settings.version>submission.target)return '设置已被另一客户端的新版本替代，请刷新后查看。';
 if(settings.version===submission.target&&(settings.appliedVersion??0)>=submission.target)return '应用成功';
 return submission.timedOut?'设置已保存，但设备尚未确认应用。':'正在应用中…';
}

/** S57：SIM 选择条的接听方式标记；没有 settings 时不显示。 */
export function simAnswerModeBadge(settings?:{mode:string}|null):'人工'|'AI'|null{
 if(settings?.mode==='normal')return '人工';
 if(settings?.mode==='ai'||settings?.mode==='timeout_ai')return 'AI';
 return null;
}
