/* ==========================================================
 * サウンドエンジン
 * Web Audio API だけで効果音とBGMを合成する(音源ファイル不要)。
 * モバイルの自動再生制限があるため、最初のタップで init() を呼ぶこと。
 * ========================================================== */

export class SoundEngine {
    constructor() {
        this.ctx = null;
        this.isInitialized = false;
        this.bgmOscs = [];
        this.bgmGain = null;
        // Cマイナー・ペンタトニック(浮遊感のある雰囲気づくり)
        this.notes = [130.81, 155.56, 196.00, 261.63, 311.13, 392.00, 523.25];
        this.arpeggioIndex = 0;
        this.lastArpTime = 0;
        this.lastDashTime = 0;
        this.lastExplosionTime = -999; // 爆発音の間引き用(連鎖爆発での飽和防止)
        this.beamNodes = null; // 照射ビームの持続音(再生中のみ保持)
    }

    init() {
        if (this.isInitialized) return;
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioContextClass();
        this.isInitialized = true;
        this.startBGM();
    }

    /** 環境音パッド:ゆっくり揺れるローパスフィルタで宇宙的な持続音を作る */
    startBGM() {
        this.bgmGain = this.ctx.createGain();
        this.bgmGain.gain.value = 0.08;
        this.bgmGain.connect(this.ctx.destination);

        const padNotes = [130.81, 196.00, 261.63]; // C3, G3, C4
        padNotes.forEach(freq => {
            const osc = this.ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.value = freq;

            const filter = this.ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 800;

            // フィルタをゆっくり揺らすLFO
            const lfo = this.ctx.createOscillator();
            lfo.type = 'sine';
            lfo.frequency.value = 0.1 + Math.random() * 0.1;
            const lfoGain = this.ctx.createGain();
            lfoGain.gain.value = 400;

            lfo.connect(lfoGain);
            lfoGain.connect(filter.frequency);

            osc.connect(filter);
            filter.connect(this.bgmGain);

            osc.start();
            lfo.start();
            this.bgmOscs.push(osc, lfo);
        });
    }

    /** BGMの装飾音(アルペジオ)を一定間隔で鳴らす */
    updateBGM(timeMs) {
        if (!this.isInitialized || !this.ctx) return;
        if (timeMs - this.lastArpTime > 150) {
            this.playArpNote();
            this.lastArpTime = timeMs;
        }
    }

    playArpNote() {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'square';
        osc.frequency.value = this.notes[this.arpeggioIndex] * 2;

        gain.gain.setValueAtTime(0, this.ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0.04, this.ctx.currentTime + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.1);

        osc.connect(gain);

        // 簡易エコー
        const delay = this.ctx.createDelay();
        delay.delayTime.value = 0.3;
        const feedback = this.ctx.createGain();
        feedback.gain.value = 0.3;

        gain.connect(delay);
        delay.connect(feedback);
        feedback.connect(delay);
        delay.connect(this.ctx.destination);
        gain.connect(this.ctx.destination);

        osc.start();
        osc.stop(this.ctx.currentTime + 0.1);

        this.arpeggioIndex = (this.arpeggioIndex + 1 + Math.floor(Math.random() * 2)) % this.notes.length;
    }

    /** 通常ショット */
    playShot() {
        if (!this.isInitialized) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(800, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(100, this.ctx.currentTime + 0.1);

        gain.gain.setValueAtTime(0.08, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.1);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start();
        osc.stop(this.ctx.currentTime + 0.1);
    }

    /** 追尾レーザー一斉発射 */
    playVolley() {
        if (!this.isInitialized) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'square';
        osc.frequency.setValueAtTime(1200, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(200, this.ctx.currentTime + 0.3);

        gain.gain.setValueAtTime(0.12, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.3);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start();
        osc.stop(this.ctx.currentTime + 0.3);
    }

    /** ロックオン成立音 */
    playLockOn() {
        if (!this.isInitialized) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(1760, this.ctx.currentTime); // A6

        gain.gain.setValueAtTime(0.08, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.05);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start();
        osc.stop(this.ctx.currentTime + 0.05);
    }

    /** 爆発音:高速な周波数変調でノイズ的な質感を出す
     *  連鎖爆発(ボス断末魔など)で音が飽和しないよう最小間隔で間引く。
     *  戻り値は実際に鳴らしたかどうか。 */
    playExplosion() {
        if (!this.isInitialized) return false;
        if (this.ctx.currentTime - this.lastExplosionTime < 0.12) return false;
        this.lastExplosionTime = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        const filter = this.ctx.createBiquadFilter();

        osc.type = 'sawtooth';
        osc.frequency.value = 100;

        const mod = this.ctx.createOscillator();
        mod.type = 'square';
        mod.frequency.value = 50;
        const modGain = this.ctx.createGain();
        modGain.gain.value = 1000;
        mod.connect(modGain);
        modGain.connect(osc.frequency);

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1000, this.ctx.currentTime);
        filter.frequency.exponentialRampToValueAtTime(100, this.ctx.currentTime + 0.5);

        gain.gain.setValueAtTime(0.25, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.5);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start();
        mod.start();
        osc.stop(this.ctx.currentTime + 0.5);
        mod.stop(this.ctx.currentTime + 0.5);
        return true;
    }

    /** ブースト(連続再生を抑制) */
    playBoost() {
        if (!this.isInitialized || this.ctx.currentTime - this.lastDashTime < 0.1) return;
        this.lastDashTime = this.ctx.currentTime;

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        const filter = this.ctx.createBiquadFilter();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(50, this.ctx.currentTime);

        filter.type = 'highpass';
        filter.frequency.value = 500;

        gain.gain.setValueAtTime(0, this.ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0.08, this.ctx.currentTime + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.2);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start();
        osc.stop(this.ctx.currentTime + 0.2);
    }

    /** アイテム取得:上昇する2音で「入手」を伝える */
    playPickup() {
        if (!this.isInitialized) return;
        [880, 1320].forEach((freq, i) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            const t = this.ctx.currentTime + i * 0.09;

            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, t);

            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(0.12, t + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.01, t + 0.15);

            osc.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start(t);
            osc.stop(t + 0.15);
        });
    }

    /** 誘導弾の発射:鋭い上昇スイープ */
    playComet() {
        if (!this.isInitialized) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'square';
        osc.frequency.setValueAtTime(500, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1600, this.ctx.currentTime + 0.15);

        gain.gain.setValueAtTime(0.1, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.15);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start();
        osc.stop(this.ctx.currentTime + 0.15);
    }

    /** ミサイル一斉発射:低い連続音で重量感を出す */
    playMissileLaunch() {
        if (!this.isInitialized) return;
        for (let i = 0; i < 4; i++) {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            const t = this.ctx.currentTime + i * 0.06;

            osc.type = 'triangle';
            osc.frequency.setValueAtTime(300, t);
            osc.frequency.exponentialRampToValueAtTime(70, t + 0.2);

            gain.gain.setValueAtTime(0.09, t);
            gain.gain.exponentialRampToValueAtTime(0.01, t + 0.2);

            osc.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start(t);
            osc.stop(t + 0.2);
        }
    }

    /** 被弾:低い衝撃音 */
    playDamage() {
        if (!this.isInitialized) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(90, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(35, this.ctx.currentTime + 0.3);

        gain.gain.setValueAtTime(0.3, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.3);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start();
        osc.stop(this.ctx.currentTime + 0.3);
    }

    /** 照射ビームの持続音を開始(stopBeamで停止するまで鳴り続ける) */
    startBeam() {
        if (!this.isInitialized || this.beamNodes) return;

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0, this.ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0.1, this.ctx.currentTime + 0.08);

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 700;

        // わずかにずらした2つの鋸波でうなりを作る
        const osc1 = this.ctx.createOscillator();
        osc1.type = 'sawtooth';
        osc1.frequency.value = 55;
        const osc2 = this.ctx.createOscillator();
        osc2.type = 'sawtooth';
        osc2.frequency.value = 55 * 1.013;

        osc1.connect(filter);
        osc2.connect(filter);
        filter.connect(gain);
        gain.connect(this.ctx.destination);

        osc1.start();
        osc2.start();
        this.beamNodes = { osc1, osc2, gain };
    }

    /** 照射ビームの持続音を停止 */
    stopBeam() {
        if (!this.beamNodes) return;
        const { osc1, osc2, gain } = this.beamNodes;
        this.beamNodes = null;
        gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.15);
        osc1.stop(this.ctx.currentTime + 0.2);
        osc2.stop(this.ctx.currentTime + 0.2);
    }

    /** ボス接近の警告:低い2音を交互に鳴らすサイレン風の音 */
    playAlarm() {
        if (!this.isInitialized) return;
        for (let i = 0; i < 4; i++) {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            const t = this.ctx.currentTime + i * 0.18;

            osc.type = 'square';
            osc.frequency.setValueAtTime(i % 2 === 0 ? 220 : 165, t);

            gain.gain.setValueAtTime(0.0001, t);
            gain.gain.linearRampToValueAtTime(0.08, t + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.01, t + 0.16);

            osc.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start(t);
            osc.stop(t + 0.17);
        }
    }

    /** ブリンク(瞬間移動):急激なピッチダウンでドップラー風の効果 */
    playBlink() {
        if (!this.isInitialized) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(1000, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(50, this.ctx.currentTime + 0.2);

        gain.gain.setValueAtTime(0.25, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.2);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start();
        osc.stop(this.ctx.currentTime + 0.2);
    }
}
