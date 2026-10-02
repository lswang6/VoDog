/** Client-side only: a verification code in an SMS body (keyword + 4–8 digits). Copy-only, never changes data. */
const KEYWORD=/验证码|校验码|动态码|确认码|code|otp|passcode/i;
export function verificationCode(body:string):string|null{
 if(!KEYWORD.test(body))return null;
 const near=body.match(/(?:验证码|校验码|动态码|确认码|code|otp|passcode)\D{0,12}?(\d{4,8})(?!\d)/i)||body.match(/(?<!\d)(\d{4,8})(?!\d)\D{0,12}?(?:验证码|校验码|动态码|确认码|code|otp|passcode)/i);
 return near?.[1]??null;
}
