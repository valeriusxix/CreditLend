// Alerts always go to the log. They are also sent to a chat if configured:
//   ALERT_WEBHOOK_URL                      a Discord or Slack incoming-webhook URL
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID  a Telegram bot
// The same alert (same key) is repeated at most once per `repeatAfter` seconds.

export class Alerter {
  constructor({ webhookUrl, telegramBotToken, telegramChatId, repeatAfter = 3600, fetchFn = globalThis.fetch, log = console, clock = () => Math.floor(Date.now() / 1000) } = {}) {
    this.webhookUrl = webhookUrl
    this.telegram = telegramBotToken && telegramChatId ? { token: telegramBotToken, chatId: telegramChatId } : null
    this.repeatAfter = repeatAfter
    this.fetch = fetchFn
    this.log = log
    this.clock = clock
    this.lastSent = new Map()
  }

  /// Returns true if the alert was emitted (false if suppressed as a repeat).
  async send({ key, level = 'info', text }) {
    const now = this.clock()
    const last = this.lastSent.get(key)
    if (last != null && now < last + this.repeatAfter) return false
    this.lastSent.set(key, now)

    const line = `[CreditLend ${level.toUpperCase()}] ${text}`
    if (level === 'info') this.log.info(line)
    else this.log.warn(line)

    const posts = []
    if (this.webhookUrl) {
      // `content` is Discord's field, `text` is Slack's; each ignores the other.
      posts.push(this._post(this.webhookUrl, { content: line, text: line }))
    }
    if (this.telegram) {
      posts.push(this._post(`https://api.telegram.org/bot${this.telegram.token}/sendMessage`, { chat_id: this.telegram.chatId, text: line }))
    }
    await Promise.all(posts)
    return true
  }

  async _post(url, body) {
    try {
      const res = await this.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) this.log.warn(`alert delivery failed: HTTP ${res.status}`)
    } catch (err) {
      // Never log the URL: webhook URLs and bot tokens are secrets.
      this.log.warn(`alert delivery failed: ${err?.name ?? 'error'}`)
    }
  }
}
