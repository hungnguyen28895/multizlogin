// services/zalo-session-keeper.js
// Giữ session Zalo luôn hợp lệ cho mỗi tài khoản đã đăng nhập.
//
// Cookie zpw_sek chỉ sống ~7 ngày (zpsid ~365 ngày). Nếu không làm mới, các API
// chat (sendMessage, ...) sẽ bị Zalo từ chối với lỗi "zpw_sek bị thiếu hoặc
// không đúng" dù đăng nhập bằng zpsid vẫn thành công. Module này:
//   1. Luôn ghi đè file cred_<ownId>.json bằng cookie mới nhất, để relogin
//      (khi listener bị đóng hoặc khi restart) không dùng lại cookie cũ đã hết hạn.
//   2. Gọi keepAlive định kỳ để Zalo gia hạn session, rồi lưu lại cookie mới.
import fs from 'fs';

const COOKIES_DIR = './data/cookies';
// Khoảng thời gian gọi keepAlive cho mỗi tài khoản (2 phút)
const KEEP_ALIVE_INTERVAL = 2 * 60 * 1000;

// ownId -> interval timer, đảm bảo mỗi tài khoản chỉ có một vòng keepAlive
const keepAliveTimers = new Map();

// ownId -> promise của lần ghi gần nhất; xếp hàng các lần ghi cùng tài khoản
// (login và keepAlive có thể ghi đồng thời, rename song song bị EPERM trên Windows)
const pendingWrites = new Map();

// Lưu imei/cookie/userAgent hiện tại của API vào file cred_<ownId>.json (ghi đè)
export function persistAccountCredentials(api, ownId) {
    const previous = pendingWrites.get(ownId) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => writeCredentials(api, ownId));
    pendingWrites.set(ownId, current);
    return current.finally(() => {
        if (pendingWrites.get(ownId) === current) pendingWrites.delete(ownId);
    });
}

async function writeCredentials(api, ownId) {
    const { imei, cookie, userAgent } = api.getContext();
    const data = { imei, cookie: cookie.toJSON(), userAgent };

    await fs.promises.mkdir(COOKIES_DIR, { recursive: true });
    const filePath = `${COOKIES_DIR}/cred_${ownId}.json`;
    // Ghi ra file tạm rồi rename để không làm hỏng file cookie nếu bị ngắt giữa chừng
    const tmpPath = `${filePath}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 4));
    await fs.promises.rename(tmpPath, filePath);
}

// Bắt đầu gọi keepAlive định kỳ cho tài khoản, thay thế vòng cũ nếu đã có
export function startSessionKeepAlive(api, ownId) {
    stopSessionKeepAlive(ownId);

    const timer = setInterval(async () => {
        try {
            await api.keepAlive();
            await persistAccountCredentials(api, ownId);
        } catch (error) {
            console.error(`Lỗi keepAlive cho tài khoản ${ownId}:`, error.message || error);
        }
    }, KEEP_ALIVE_INTERVAL);
    // Không giữ process sống chỉ vì timer keepAlive
    timer.unref?.();
    keepAliveTimers.set(ownId, timer);
}

export function stopSessionKeepAlive(ownId) {
    const timer = keepAliveTimers.get(ownId);
    if (timer) {
        clearInterval(timer);
        keepAliveTimers.delete(ownId);
    }
}
