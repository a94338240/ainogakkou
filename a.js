const CryptoBox = {
    async deriveKey(password, salt) {
        const encoder = new TextEncoder();
        const baseKey = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
            baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
        );
    },
    async encrypt(plainText, password) {
        const encoder = new TextEncoder();
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await this.deriveKey(password, salt);
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plainText));
        return { salt, iv, ciphertext };
    },
    async decrypt(encObj, password) {
        const key = await this.deriveKey(password, encObj.salt);
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: encObj.iv }, key, encObj.ciphertext);
        return new TextDecoder().decode(decrypted);
    }
};

// --- 2. 数据库与 Mime 探测 ---
class MyStorage {
    constructor() { this.db = null; }
    async init() {
        return new Promise(res => {
            const req = indexedDB.open("SecureShadowing", 1);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                db.createObjectStore('audios', { keyPath: 'id' });
                db.createObjectStore('config', { keyPath: 'key' });
            };
            req.onsuccess = e => { this.db = e.target.result; res(); };
        });
    }
    async set(store, data) {
        const tx = this.db.transaction([store], 'readwrite');
        tx.objectStore(store).put(data);
    }
    async get(store, key) {
        const tx = this.db.transaction([store], 'readonly');
        const req = tx.objectStore(store).get(key);
        return new Promise(res => req.onsuccess = () => res(req.result));
    }
}

const storage = new MyStorage();
let mediaRecorder, audioChunks = [], audioBlob, currentMimeType = '';

// 页面启动
(async () => {
    await storage.init();
    document.getElementById('status').innerText = "安全环境就绪";
})();

// --- 3. 录音逻辑 ---
document.getElementById('startBtn').onclick = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    currentMimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    mediaRecorder = new MediaRecorder(stream, { mimeType: currentMimeType });
    audioChunks = [];
    mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
    mediaRecorder.onstop = async () => {
        audioBlob = new Blob(audioChunks, { type: currentMimeType });
        await storage.set('audios', { id: 'last_rec', data: audioBlob });
        document.getElementById('audioPlayback').src = URL.createObjectURL(audioBlob);
        document.getElementById('audioPlayback').style.display = 'block';
        document.getElementById('uploadBtn').disabled = false;
        document.getElementById('status').innerText = "录音本地已存";
    };
    mediaRecorder.start();
    document.getElementById('startBtn').disabled = true;
    document.getElementById('stopBtn').disabled = false;
};

document.getElementById('stopBtn').onclick = () => {
    mediaRecorder.stop();
    document.getElementById('startBtn').disabled = false;
    document.getElementById('stopBtn').disabled = true;
};

document.getElementById('configBtn').onclick = () => document.getElementById('tokenDialog').showModal();
document.getElementById('saveConfigBtn').onclick = async () => {
    const token = document.getElementById('tokenInput').value;
    const repo = document.getElementById('repoInput').value;
    const pwd = document.getElementById('masterPwdInput').value;
    if (!token || !pwd || !repo) return alert("请完整填写信息！");

    const encryptedToken = await CryptoBox.encrypt(token, pwd);
    await storage.set('config', { key: 'gh_token', value: encryptedToken });
    await storage.set('config', { key: 'gh_repo', value: repo });
    document.getElementById('tokenDialog').close();
    alert("配置已加密存储！");
};

document.getElementById('uploadBtn').onclick = async () => {
    const encTokenObj = await storage.get('config', 'gh_token');
    const repoCfg = await storage.get('config', 'gh_repo');
    if (!encTokenObj) return alert("请先配置 GitHub！");

    const pwd = prompt("请输入主密码以解密 Token 发起上传:");
    if (!pwd) return;

    try {
        const plainToken = await CryptoBox.decrypt(encTokenObj.value, pwd);
        document.getElementById('status').innerText = "解密成功，正在上传...";
        
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = async () => {
            const base64 = reader.result.split(',')[1];
            const ext = currentMimeType.includes('mp4') ? '.mp4' : '.webm';
            const res = await fetch(`https://api.github.com/repos/${repoCfg.value}/contents/recording_${Date.now()}${ext}`, {
                method: 'PUT',
                headers: { 'Authorization': `token ${plainToken}` },
                body: JSON.stringify({ message: 'Secure upload', content: base64 })
            });
            document.getElementById('status').innerText = res.ok ? "🎉 上传成功" : "❌ 上传失败";
        };
    } catch (e) { alert("密码错误，解密失败！"); }
};
//# sourceURL=_dyn_s1.js