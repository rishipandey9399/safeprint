/**
 * SMS provider interface. Production would plug MSG91/Twilio in here; the
 * console provider is the dev mock (no API keys needed to run locally).
 */
export interface OtpProvider {
  sendOtp(phone: string, code: string): Promise<void>;
  notify(phone: string, message: string): Promise<void>;
}

class ConsoleOtpProvider implements OtpProvider {
  async sendOtp(phone: string, code: string): Promise<void> {
    console.log(`[SafePrint SMS mock] OTP for ${phone || "(no phone given)"}: ${code}`);
  }
  async notify(phone: string, message: string): Promise<void> {
    console.log(`[SafePrint SMS mock] Notification for ${phone || "(no phone given)"}: ${message}`);
  }
}

export function getOtpProvider(): OtpProvider {
  return new ConsoleOtpProvider();
}
