/* ==========================================================
 * GRAVITY ZERO — 全網羅テストスイート
 *
 * ゲーム本体(main.js)を実際に読み込み、公開された window.game /
 * window.ZMF に対してロジックを直接動かして検証する統合テスト。
 * 各テストは同期実行なので、背景の描画ループが割り込むことはない。
 *
 * ブラウザで tests/test.html を開くと結果が画面に表示される。
 * ヘッドレス確認用に window.__testResults にも要約を格納する。
 * ========================================================== */

function runAll() {
    const g = window.game;
    const Z = window.ZMF;
    const M = Z.FLIGHT_MODES;
    const C = Z.constants;

    // 起動直後の状態を記録してから開始する(タイトル状態の検証用)
    const stateAtBoot = g.state;

    // キー入力系のテストのために、開始処理(入力リスナー登録)を済ませておく
    const startBtn = document.querySelector('#start-overlay .start-btn');
    if (startBtn && document.getElementById('start-overlay').style.display !== 'none') {
        startBtn.click();
    }

    // ---------- テストランナー ----------
    const groups = [];
    let cur = null;
    const group = (name, body) => {
        cur = { name, cases: [] };
        groups.push(cur);
        try {
            body();
        } catch (err) {
            cur.cases.push({
                name: '例外が発生', ok: false,
                detail: (err && err.message) + ' | ' + (err && err.stack ? err.stack.split('\n')[1] : ''),
            });
        }
    };
    const check = (name, cond, detail = '') => cur.cases.push({ name, ok: !!cond, detail: cond ? '' : detail });
    const approx = (a, b, eps) => Math.abs(a - b) <= eps;

    // ---------- 補助 ----------
    const setMode = (i) => { g.currentModeIndex = i; g.updateModeUI(); };
    // allowBoss=false の間はスコアに関係なくボスを湧かせない(テストの独立性を保つ)
    const step = (n, allowBoss = false) => {
        for (let k = 0; k < n; k++) {
            g.spawnTimer = 1e9;
            if (!allowBoss && !g.boss.active) g.nextBossScore = Number.MAX_SAFE_INTEGER;
            g.update(1 / 60);
        }
    };
    const countActive = (pool) => { let n = 0; pool.forEachActive(() => n++); return n; };
    const withRandom = (val, fn) => {
        const orig = Math.random;
        Math.random = () => val;
        try { return fn(); } finally { Math.random = orig; }
    };
    const spawnEnemy = (x, y, z, hp = 1, size = 10) => {
        const e = g.enemies.get();
        e.id = ++g.enemyIdCounter;
        e.size = size; e.hp = hp; e.locked = false;
        e.kind = 'rush'; // プール再利用で前の種類が残らないようにする
        e.grazed = true; // グレイズは専用テストでのみ有効化する(他テストへの混入防止)
        e.mesh.position.set(x, y, z); e.vel.set(0, 0, 0);
        e.mesh.scale.setScalar(size); e.mesh.visible = true;
        e.mesh.material = g.enemyMats[0]; e.colorHex = '#ff3366';
        return e;
    };
    const placeBullet = (x, y, z) => {
        const b = g.bullets.get();
        b.mesh.position.set(x, y, z); b.vel.set(0, 0, 0); b.mesh.visible = true;
        return b;
    };
    const placeBossShot = (x, y, z) => {
        const s = g.enemyShots.get();
        s.mesh.position.set(x, y, z); s.vel.set(0, 0, 0); s.mesh.visible = true;
        return s;
    };
    const newestEnemy = () => {
        let best = null;
        g.enemies.forEachActive(e => { if (!best || e.id > best.id) best = e; });
        return best;
    };
    // 仮想クロックで実ループを1フレーム進める(一時停止判定の確認用)
    const runLoopFrame = (ms = 16) => {
        const now = (g.lastTime || 0) + ms;
        g._lastFrameTs = null;
        g.loop(now);
    };

    // =========================================================
    group('初期化 / 公開API', () => {
        check('window.game が生成されている', !!g);
        check('window.ZMF が公開されている', !!Z);
        check('機体モードは3種類', M.length === 3, `実際: ${M.length}`);
        check('サブ武器は3種類', Object.keys(Z.SUB_WEAPONS).length === 3);
        check('主要メソッドが存在する',
            typeof g.reset === 'function' && typeof g.damagePlayer === 'function' &&
            typeof g.equipSubWeapon === 'function' && typeof g.openHelp === 'function');
        check('ボス・キー設定のメソッドが存在する',
            typeof g.spawnBoss === 'function' && typeof g.damageBoss === 'function' &&
            typeof g.setKeyBinding === 'function' && typeof g.resetKeyBindings === 'function');
        check('デバッグ・ランキング・敵生成のメソッドが存在する',
            typeof g.toggleDebug === 'function' && typeof g.saveScoreToRanking === 'function' &&
            typeof g.spawnEnemyUnit === 'function' && typeof g.backToTitle === 'function');
    });

    // =========================================================
    group('フライト慣性モデル', () => {
        g.reset(); setMode(1);
        g.input.x = 1; g.input.y = 0;
        step(30);
        check('右入力で右へ移動する', g.player.pos.x > 5, `x=${g.player.pos.x.toFixed(1)}`);

        g.input.x = 0;
        const speedBefore = Math.hypot(g.player.vel.x, g.player.vel.y);
        step(60);
        const speedAfter = Math.hypot(g.player.vel.x, g.player.vel.y);
        check('入力を離すと抵抗で減速する', speedAfter < speedBefore, `${speedBefore.toFixed(0)}→${speedAfter.toFixed(0)}`);

        g.reset(); setMode(1);
        g.player.pos.x = C.BOUND_X + 60; g.player.vel.x = 120;
        step(3);
        check('右端で座標がクランプされる', g.player.pos.x <= C.BOUND_X + 0.01, `x=${g.player.pos.x.toFixed(1)}`);
        check('右端で速度が反発(符号反転)する', g.player.vel.x < 0, `vx=${g.player.vel.x.toFixed(1)}`);
    });

    // =========================================================
    group('モード切替', () => {
        g.reset();
        g.currentModeIndex = 1; g.switchMode();
        check('標準→重装へ切替', g.currentModeIndex === 2, `idx=${g.currentModeIndex}`);
        g.switchMode();
        check('重装→軽量へ循環', g.currentModeIndex === 0, `idx=${g.currentModeIndex}`);
        check('モードごとに質量が異なる', M[0].mass !== M[1].mass && M[1].mass !== M[2].mass);
        check('モードごとに抵抗が異なる', M[0].drag !== M[1].drag && M[1].drag !== M[2].drag);
    });

    // =========================================================
    group('モード固有の個性(防御・連射・火力)', () => {
        const dmgFor = (idx) => {
            g.reset(); setMode(idx);
            g.hp = 100; g.player.hitInvincible = 0;
            g.damagePlayer(10);
            return 100 - g.hp;
        };
        const dLight = dmgFor(0), dStd = dmgFor(1), dHeavy = dmgFor(2);
        check('軽量は被弾ダメージが大きい(装甲弱)', approx(dLight, 10 * M[0].damageMult, 0.01), `受けた=${dLight}`);
        check('重装は被弾ダメージが小さい(装甲強)', approx(dHeavy, 10 * M[2].damageMult, 0.01), `受けた=${dHeavy}`);
        check('装甲の強弱が 軽量>標準>重装 の順', dLight > dStd && dStd > dHeavy, `${dLight}/${dStd}/${dHeavy}`);

        check('連射間隔が 軽量<標準<重装', M[0].fireInterval < M[1].fireInterval && M[1].fireInterval < M[2].fireInterval,
            `${M[0].fireInterval}/${M[1].fireInterval}/${M[2].fireInterval}`);

        g.reset(); setMode(0);
        let e = spawnEnemy(0, 0, -300, 2);
        placeBullet(0, 0, -300);
        step(1);
        check('軽量の弾は1発で威力1(耐久2を1発で倒せない)', e.active && e.hp === 1, `hp=${e.hp} active=${e.active}`);

        g.reset(); setMode(2);
        e = spawnEnemy(0, 0, -300, 2);
        placeBullet(0, 0, -300);
        step(1);
        check('重装の弾は1発で威力2(耐久2を1発で撃破)', !e.active, `active=${e.active}`);
    });

    // =========================================================
    group('通常ショット', () => {
        g.reset(); setMode(1);
        g.lastFireTime = 0; g.input.fire = true; g.player.freezeTimer = 0;
        step(1);
        check('ショットで弾が生成される', countActive(g.bullets) >= 1, `弾=${countActive(g.bullets)}`);
        let anyForward = false;
        g.bullets.forEachActive(b => { if (b.vel.z < -100) anyForward = true; });
        check('弾は前方(-Z)へ飛ぶ', anyForward);
        g.input.fire = false;
    });

    // =========================================================
    group('一斉ロックオン → 追尾レーザー', () => {
        g.reset();
        spawnEnemy(-40, 0, -300); spawnEnemy(0, 0, -300); spawnEnemy(40, 0, -300);
        g.input.lock = true;
        step(30);
        check('前方円錐内の3機をロックする', g.player.lockedTargets.length === 3, `ロック=${g.player.lockedTargets.length}`);
        g.input.lock = false;
        step(1);
        check('ボタンを離すと固定24発が発射される', countActive(g.homingLasers) === C.VOLLEY_COUNT,
            `弾=${countActive(g.homingLasers)}`);
        check('発射後に短い硬直に入る', g.player.freezeTimer > 0, `freeze=${g.player.freezeTimer.toFixed(2)}`);
    });

    // =========================================================
    group('サブ武器: ハルバード(照射レーザー・5秒CT)', () => {
        g.reset();
        g.equipSubWeapon('halberd');
        check('装備される', g.player.subWeapon === 'halberd');
        check('取得で300点入る', g.score === 300, `score=${g.score}`);

        g.input.sub = true;
        step(3);
        check('押している間ビームが出る', g.player.beamActive && g.beamGroup.visible);

        const e = spawnEnemy(0, 0, -300, 2);
        step(45); // 約0.75秒照射(14dps×0.75≈10 > 耐久2)
        check('ビームの継続ダメージで敵を倒す', !e.active, `hp=${e.hp.toFixed(1)}`);

        g.input.sub = false;
        step(1);
        check('離すとビームが消える', !g.player.beamActive);
        // 約0.8秒しか使っていないので、クールタイムは最低値の約1秒になる
        check('短時間の照射なら短いクールタイム(最低1秒)',
            g.player.subCooldown >= 0.9 && g.player.subCooldown <= 1.5,
            `CT=${g.player.subCooldown.toFixed(2)}`);
    });

    // =========================================================
    group('ハルバードの照射時間上限(5秒)', () => {
        g.reset();
        g.equipSubWeapon('halberd');
        g.input.sub = true;
        step(3);
        check('照射が始まる', g.player.beamActive);

        // 押しっぱなしのまま、自動停止するまで進める
        let frames = 3;
        while (g.player.beamActive && frames < 400) { step(1); frames++; }
        check('約5秒(300フレーム)で自動停止する', frames >= 295 && frames <= 310, `frames=${frames}`);
        check('フル使用時のクールタイムは約5秒', approx(g.player.subCooldown, 5, 0.1), `CT=${g.player.subCooldown.toFixed(2)}`);

        step(30);
        check('押しっぱなしでも再照射されない(CT中)', !g.player.beamActive && g.player.subCooldown > 0,
            `CT=${g.player.subCooldown.toFixed(2)}`);
        g.input.sub = false;
    });

    // =========================================================
    group('ハルバードの残量ゲージ', () => {
        g.reset();
        g.equipSubWeapon('halberd');
        g.input.sub = true;
        step(150); // 約2.5秒照射 = 残り時間約50%
        const w = parseFloat(document.getElementById('subcd-fill').style.width);
        check('照射中はゲージが残り時間を示す(約50%)', w > 35 && w < 65, `w=${w}%`);
        g.input.sub = false;
        step(1);
    });

    // =========================================================
    group('サブ武器: コメット(単発誘導弾・1秒CT)', () => {
        g.reset();
        g.equipSubWeapon('comet');
        const e = spawnEnemy(80, 40, -400);
        g.input.sub = true;
        step(1);
        check('1発だけ発射される', countActive(g.comets) === 1, `弾=${countActive(g.comets)}`);
        check('クールタイムは約1秒', approx(g.player.subCooldown, 1, 0.05), `CT=${g.player.subCooldown.toFixed(2)}`);
        g.input.sub = false;
        step(90);
        check('誘導して敵に命中する', !e.active);
    });

    // =========================================================
    group('サブ武器: ホーミングミサイル(10発・10秒CT)', () => {
        g.reset();
        g.equipSubWeapon('missile');
        const e1 = spawnEnemy(-100, 50, -500);
        const e2 = spawnEnemy(120, -60, -450);
        g.input.sub = true;
        step(1);
        check('10発が一斉に発射される', countActive(g.missiles) === C.MISSILE_COUNT, `弾=${countActive(g.missiles)}`);
        check('クールタイムは約10秒', approx(g.player.subCooldown, 10, 0.1), `CT=${g.player.subCooldown.toFixed(1)}`);
        let vySum = 0, cnt = 0;
        g.missiles.forEachActive(m => { vySum += Math.abs(m.vel.y); cnt++; });
        check('打ち出しは垂直方向が主体', (vySum / cnt) > 250, `平均|vy|=${(vySum / cnt).toFixed(0)}`);
        g.input.sub = false;
        step(200);
        check('その後ホーミングで敵を追尾・撃破する', !e1.active && !e2.active, `e1=${e1.active} e2=${e2.active}`);
    });

    // =========================================================
    group('サブ武器はショットと同時に使える', () => {
        g.reset();
        g.equipSubWeapon('comet');
        g.lastFireTime = 0;
        g.input.fire = true; g.input.sub = true;
        spawnEnemy(0, 30, -400);
        step(1);
        check('同フレームで通常弾とサブ武器が両方出る',
            countActive(g.bullets) >= 1 && countActive(g.comets) >= 1,
            `弾=${countActive(g.bullets)} コメット=${countActive(g.comets)}`);
        g.input.fire = false; g.input.sub = false;
    });

    // =========================================================
    group('スコアと難易度スケーリング', () => {
        g.reset();
        check('初期レベルは1', g.level === 1);
        g.addScore(1499);
        check('1499点ではレベル1', g.level === 1, `lv=${g.level}`);
        g.addScore(1);
        check('1500点でレベル2', g.level === 2, `lv=${g.level}`);
        g.reset();
        g.addScore(4600);
        check('4600点でレベル4', g.level === 4, `lv=${g.level}`);

        g.reset();
        withRandom(0.999, () => {
            const small = spawnEnemy(0, 0, -300, 1, 10);
            g.destroyEnemy(small);
        });
        check('小型撃破で100点', g.score === 100, `score=${g.score}`);
        g.reset(); // コンボの影響を切ってから大型を検証する
        withRandom(0.999, () => {
            const big = spawnEnemy(0, 0, -300, 1, 15);
            g.destroyEnemy(big);
        });
        check('大型撃破で200点', g.score === 200, `score=${g.score}`);

        // レベルに応じた敵の強化(決定論的にスポーンさせて確認)
        g.reset();
        g.nextBossScore = Number.MAX_SAFE_INTEGER; // ボスの介入を防ぐ
        withRandom(0.99, () => { g.spawnTimer = 0; g.update(1 / 60); });
        const lowLvEnemy = newestEnemy();
        const lowHp = lowLvEnemy.hp, lowVz = lowLvEnemy.vel.z;

        g.reset();
        g.addScore(9000); // レベル7
        g.nextBossScore = Number.MAX_SAFE_INTEGER;
        withRandom(0.99, () => { g.spawnTimer = 0; g.update(1 / 60); });
        const hiLvEnemy = newestEnemy();
        check('高レベルほど敵の耐久が高い', hiLvEnemy.hp > lowHp, `lv1=${lowHp} lv7=${hiLvEnemy.hp}`);
        check('高レベルほど敵の突入速度が速い', hiLvEnemy.vel.z > lowVz, `lv1=${lowVz.toFixed(0)} lv7=${hiLvEnemy.vel.z.toFixed(0)}`);
    });

    // =========================================================
    group('HP・被弾・無敵・ゲームオーバー', () => {
        g.reset(); setMode(1);
        check('初期HPは最大', g.hp === C.PLAYER_MAX_HP);

        spawnEnemy(0, 0, 0); // 自機に重ねる
        step(1);
        check('接触で25ダメージ', g.hp === 75, `hp=${g.hp}`);
        check('被弾直後は無敵になる', g.player.hitInvincible > 0);

        spawnEnemy(0, 0, 0);
        step(1);
        check('無敵中は連続被弾しない', g.hp === 75, `hp=${g.hp}`);

        for (let i = 0; i < 3; i++) {
            g.player.hitInvincible = 0;
            spawnEnemy(0, 0, 0);
            step(1);
        }
        check('HP0でゲームオーバーになる', g.state === 'gameover', `state=${g.state}`);
        check('ゲームオーバー画面が表示される', document.getElementById('gameover-overlay').style.display === 'flex');
        check('自機が非表示になる', g.player.group.visible === false);
        check('ヘルプボタンが隠れる', document.getElementById('help-btn').style.display === 'none');
    });

    // =========================================================
    group('リスタート(reset)', () => {
        g.reset();
        check('状態がプレイ中へ戻る', g.state === 'playing');
        check('HPが全回復する', g.hp === C.PLAYER_MAX_HP);
        check('スコア・レベルが初期化される', g.score === 0 && g.level === 1);
        check('サブ武器が未装備に戻る', g.player.subWeapon === null);
        check('自機が再表示される', g.player.group.visible === true);
        check('ゲームオーバー画面が閉じる', document.getElementById('gameover-overlay').style.display === 'none');
        check('ヘルプボタンが再表示される', document.getElementById('help-btn').style.display === 'flex');
        check('ボスとボス弾も消える', !g.boss.active && countActive(g.enemyShots) === 0);
        check('押しっぱなし入力が持ち越されない',
            !g.input.fire && !g.input.sub && !g.input.boost && !g.input.lock && g.input.x === 0);
        const leftover = countActive(g.enemies) + countActive(g.bullets) + countActive(g.homingLasers) +
                         countActive(g.comets) + countActive(g.missiles) + countActive(g.items) + countActive(g.enemyShots);
        check('場のオブジェクトが全消去される', leftover === 0, `残=${leftover}`);
    });

    // =========================================================
    group('アイテム取得によるサブ武器入手', () => {
        g.reset();
        withRandom(0.99, () => g.spawnItem({ x: 5, y: 5, z: 0 }));
        check('アイテムが出現する', countActive(g.items) === 1);
        const itm = g.items.pool.find(i => i.active);
        const type = itm.type;
        check('高乱数ではサブ武器がドロップする', Z.ITEM_TYPES.includes(type), `type=${type}`);
        step(1);
        check('取得でサブ武器を装備する', g.player.subWeapon === type, `装備=${g.player.subWeapon}`);
        check('取得で300点入る', g.score === 300, `score=${g.score}`);
        check('取得したアイテムは消える', countActive(g.items) === 0);

        g.reset();
        g.equipSubWeapon('comet');
        g.equipSubWeapon('missile');
        check('新しいサブ武器で上書きされる', g.player.subWeapon === 'missile');
        check('HUDのサブ武器名が更新される', document.getElementById('sub-name').innerText === 'HOMING MISSILE');
    });

    // =========================================================
    group('修理アイテム', () => {
        g.reset(); setMode(1);
        g.hp = 40; g.updateHpBar();
        g.spawnItem({ x: 5, y: 5, z: 0 }, 'repair');
        step(1);
        check('取得で30回復する', g.hp === 40 + C.REPAIR_HEAL, `hp=${g.hp}`);
        check('回復ボーナスで100点入る', g.score === 100, `score=${g.score}`);
        check('サブ武器の装備は変わらない', g.player.subWeapon === null);

        g.hp = 90; g.updateHpBar();
        g.spawnItem({ x: 5, y: 5, z: 0 }, 'repair');
        step(1);
        check('最大HPを超えて回復しない', g.hp === C.PLAYER_MAX_HP, `hp=${g.hp}`);

        // 低乱数では修理アイテムがドロップする(30%枠)
        g.reset();
        withRandom(0.1, () => g.spawnItem({ x: 0, y: 0, z: -500 }));
        const itm = g.items.pool.find(i => i.active);
        check('低乱数では修理アイテムがドロップする', itm && itm.type === 'repair', `type=${itm && itm.type}`);
    });

    // =========================================================
    group('ボス戦', () => {
        g.reset(); setMode(1);
        check('開始時はボス不在', !g.boss.active);
        check('初回ボスの出現基準スコア', g.nextBossScore === C.BOSS_FIRST_SCORE, `next=${g.nextBossScore}`);

        g.addScore(C.BOSS_FIRST_SCORE);
        step(1, true);
        check('基準スコア到達でボスが出現する', g.boss.active);
        check('ボスの耐久ゲージが表示される', document.getElementById('boss-bar-wrap').style.display === 'block');
        check('ボス耐久はレベルに比例する', g.boss.maxHp === 80 + g.level * 25, `maxHp=${g.boss.maxHp}`);

        // ボス戦中は雑魚の出現間隔が延びる(同一乱数で比較)
        const bossInterval = withRandom(0.5, () => { g.spawnTimer = 0; g.update(1 / 60); return g.spawnTimer; });
        g.boss.active = false;
        const savedNext = g.nextBossScore;
        g.nextBossScore = Number.MAX_SAFE_INTEGER;
        const normalInterval = withRandom(0.5, () => { g.spawnTimer = 0; g.update(1 / 60); return g.spawnTimer; });
        g.nextBossScore = savedNext;
        g.boss.active = true;
        check('ボス戦中は雑魚の出現間隔が延びる', bossInterval > normalInterval * 2,
            `boss=${bossInterval.toFixed(2)} normal=${normalInterval.toFixed(2)}`);

        step(80, true); // 約1.3秒:初回発射(1.2秒)を跨ぐ
        check('ボスが自機を狙って弾を撃つ', countActive(g.enemyShots) > 0, `shots=${countActive(g.enemyShots)}`);

        const hpBefore = g.boss.hp;
        placeBullet(g.boss.mesh.position.x, g.boss.mesh.position.y, g.boss.mesh.position.z);
        step(1, true);
        check('通常弾でボスにダメージが入る', g.boss.hp < hpBefore, `${hpBefore.toFixed(0)}→${g.boss.hp.toFixed(0)}`);

        // ロックオンと追尾レーザーの対象になる
        g.boss.mesh.position.set(0, 0, -400);
        g.player.pos.set(0, 0, 0);
        g.player.hitInvincible = 5; // 検証中の被弾を防ぐ
        g.input.lock = true;
        step(45, true);
        check('ボスをロックオンできる', g.player.lockedTargets.includes(g.boss));
        g.input.lock = false;
        step(1, true);
        let lasersAtBoss = 0;
        g.homingLasers.forEachActive(l => { if (l.target === g.boss) lasersAtBoss++; });
        check('追尾レーザーがボスを狙う', lasersAtBoss >= 1, `lasers=${lasersAtBoss}`);

        // 撃破(残存ボス弾のクリアも確認する)
        placeBossShot(200, 200, -300);
        const scoreBefore = g.score;
        g.damageBoss(999999);
        check('撃破でボスが退場する', !g.boss.active);
        check('撃破と同時に残ったボス弾が消える', countActive(g.enemyShots) === 0,
            `shots=${countActive(g.enemyShots)}`);
        check('撃破ボーナスが入る', g.score - scoreBefore === C.BOSS_BONUS_SCORE, `+${g.score - scoreBefore}`);
        let dropped = null;
        g.items.forEachActive(i => { dropped = i; });
        check('修理アイテムを確定ドロップする', dropped && dropped.type === 'repair', `type=${dropped && dropped.type}`);
        check('次のボス基準が更新される', g.nextBossScore === g.score + C.BOSS_SCORE_INTERVAL,
            `next=${g.nextBossScore} score=${g.score}`);
        check('耐久ゲージが隠れる', document.getElementById('boss-bar-wrap').style.display === 'none');
    });

    // =========================================================
    group('ボス弾の被弾', () => {
        g.reset(); setMode(1);
        placeBossShot(0, 0, 0);
        g.player.hitInvincible = 0;
        step(1);
        check('ボス弾でダメージを受ける', g.hp === C.PLAYER_MAX_HP - C.BOSS_SHOT_DAMAGE, `hp=${g.hp}`);
        check('命中した弾は消える', countActive(g.enemyShots) === 0);

        g.reset(); setMode(1);
        placeBossShot(0, 0, 0);
        g.player.blinkCooldown = C.BLINK_COOLDOWN; // ゼロシフト直後の無敵
        step(1);
        check('無敵中(ゼロシフト直後)はボス弾を受けない', g.hp === C.PLAYER_MAX_HP, `hp=${g.hp}`);
        g.player.blinkCooldown = 0;
    });

    // =========================================================
    group('キーコンフィグ', () => {
        localStorage.removeItem(Z.storageKeys.keys);
        g.resetKeyBindings();
        check('初期キー割り当てが正しい',
            g.keyBindings.fire === 'Space' && g.keyBindings.sub === 'KeyR' && g.keyBindings.help === 'KeyH');
        check('設定UIに全アクションの行がある',
            document.querySelectorAll('#keyconfig-rows .keyconfig-row').length === Object.keys(Z.DEFAULT_KEYS).length);
        check('キー名が読みやすく表示される', Z.keyLabel('Space') === 'SPACE' && Z.keyLabel('KeyR') === 'R');

        g.setKeyBinding('fire', 'KeyJ');
        check('ショットをJキーへ変更できる', g.keyBindings.fire === 'KeyJ');
        const saved = JSON.parse(localStorage.getItem(Z.storageKeys.keys));
        check('変更が保存される', saved && saved.fire === 'KeyJ');

        g.reset();
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ' }));
        check('変更後のキーで入力が入る', g.input.fire === true);
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyJ' }));
        check('離すと入力が切れる', g.input.fire === false);
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
        check('元のキーでは反応しない', g.input.fire === false);
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));

        g.setKeyBinding('boost', 'KeyJ'); // ショットがKeyJ使用中 → 入れ替わるはず
        check('重複キーは入れ替えで解決する',
            g.keyBindings.boost === 'KeyJ' && g.keyBindings.fire === 'KeyE',
            `boost=${g.keyBindings.boost} fire=${g.keyBindings.fire}`);

        // 「キーを押して割り当て」の流れ
        g.keyCaptureAction = 'blink';
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' }));
        check('押したキーがそのまま割り当てられる', g.keyBindings.blink === 'KeyZ' && g.keyCaptureAction === null);
        check('割り当て中のキーはゲーム操作にならない', g.input.blink === false);

        g.resetKeyBindings();
        check('初期設定に戻せる', g.keyBindings.fire === 'Space' && g.keyBindings.blink === 'KeyQ');
    });

    // =========================================================
    group('ハイスコア保存', () => {
        localStorage.removeItem(Z.storageKeys.best);
        g.reset();
        g.addScore(777);
        g.gameOver();
        check('ゲームオーバーでベストスコアを保存する', localStorage.getItem(Z.storageKeys.best) === '777');
        check('ベストスコアが表示される', document.getElementById('best-score').innerText === '777');
        check('撃破数が表示される', document.getElementById('final-kills').innerText === String(g.killCount));

        g.reset();
        g.addScore(10);
        g.gameOver();
        check('より低いスコアでは更新しない', localStorage.getItem(Z.storageKeys.best) === '777');
        check('表示は過去のベストのまま', document.getElementById('best-score').innerText === '777');
        g.reset();
    });

    // =========================================================
    group('オブジェクトプールの上限', () => {
        g.reset();
        for (let i = 0; i < 200; i++) g.spawnHomingLaser(g.player.pos, g.player.vel, null);
        check('レーザーはプール上限を超えない', countActive(g.homingLasers) <= 60, `active=${countActive(g.homingLasers)}`);

        g.reset();
        for (let i = 0; i < 200; i++) { const b = g.bullets.get(); if (b) b.mesh.visible = true; }
        check('弾はプール上限を超えない', countActive(g.bullets) <= 60, `active=${countActive(g.bullets)}`);
    });

    // =========================================================
    group('一時停止 / ヘルプ', () => {
        g.reset();
        g.openHelp();
        check('ヘルプで一時停止状態になる', g.state === 'paused');
        check('ヘルプ画面が表示される', document.getElementById('help-overlay').style.display === 'flex');
        check('helpOpen フラグが立つ', g.helpOpen === true);

        g.lastTime = 1000; g.input.x = 1; g.spawnTimer = 1e9;
        const pausedX = g.player.pos.x;
        runLoopFrame(16);
        check('一時停止中は自機が動かない', g.player.pos.x === pausedX, `x=${g.player.pos.x.toFixed(2)}`);

        g.closeHelp();
        check('再開でプレイ中へ戻る', g.state === 'playing');
        check('ヘルプ画面が閉じる', document.getElementById('help-overlay').style.display === 'none');

        g.lastTime = 2000; g.input.x = 1; g.spawnTimer = 1e9; g.nextBossScore = Number.MAX_SAFE_INTEGER;
        const resumedX = g.player.pos.x;
        runLoopFrame(16);
        check('再開後は自機が動く', g.player.pos.x !== resumedX, `x=${g.player.pos.x.toFixed(2)}`);
        g.input.x = 0;

        g.toggleHelp();
        check('トグルで一時停止', g.state === 'paused');
        g.toggleHelp();
        check('トグルで再開', g.state === 'playing');
    });

    // =========================================================
    group('HUD 表示の更新', () => {
        g.reset();
        g.addScore(250);
        check('スコア表示が更新される', document.getElementById('score-display').innerText === '250');
        g.equipSubWeapon('comet');
        check('サブ武器名が更新される', document.getElementById('sub-name').innerText === 'COMET');
        setMode(1); g.hp = 100; g.player.hitInvincible = 0;
        g.damagePlayer(50);
        check('HPバー幅が減る', parseFloat(document.getElementById('hp-fill').style.width) < 100,
            `w=${document.getElementById('hp-fill').style.width}`);
        g.healPlayer(50);
        check('回復でHPバー幅が戻る', parseFloat(document.getElementById('hp-fill').style.width) === 100,
            `w=${document.getElementById('hp-fill').style.width}`);

        setMode(2);
        check('重装は防御ラベルが HIGH', document.getElementById('trait-def').innerText === 'HIGH');
        check('重装は火力ラベルが HIGH', document.getElementById('trait-pow').innerText === 'HIGH');
        check('重装は連射ラベルが SLOW', document.getElementById('trait-fire').innerText === 'SLOW');
        check('強みラベルは good 配色', document.getElementById('trait-def').className.includes('trait-good'));
        check('弱みラベルは bad 配色', document.getElementById('trait-fire').className.includes('trait-bad'));
    });

    // =========================================================
    group('UI表示の簡素化', () => {
        check('デバッグ表示(質量・抵抗)が撤去されている',
            !document.getElementById('stat-mass') && !document.getElementById('stat-drag'));
        check('モードの長文説明がHUDに無い', !document.getElementById('mode-desc'));
        check('常時表示の操作ガイドが無い', !document.querySelector('#ui-layer .controls'));
        check('HUDは1パネルのみ', document.querySelectorAll('#ui-layer .panel').length === 1);
    });

    // =========================================================
    group('タイトル画面の整理', () => {
        check('タイトルに詳細ガイドカードが無い', !document.querySelector('#start-overlay .guide-card'));
        check('タイトルは簡潔なヒントのみ', !!document.querySelector('#start-overlay .quick-hints'));
        check('詳しい操作説明はヘルプ画面へ移動', !!document.querySelector('#help-overlay .guide-grid'));

        localStorage.setItem(Z.storageKeys.best, '1234');
        g.refreshBestOnTitle();
        check('タイトルにベストスコアが表示される', document.getElementById('start-best').innerText === '1234');
        localStorage.removeItem(Z.storageKeys.best);
    });

    // =========================================================
    group('ゼロシフト(旧: 瞬間移動)', () => {
        check('移動距離が80へ延長されている', C.BLINK_DIST === 80, `dist=${C.BLINK_DIST}`);
        g.reset();
        g.input.x = 1; g.input.y = 0; g.input.blink = true;
        const x0 = g.player.pos.x;
        step(1);
        check('ゼロシフトで一気に移動する', g.player.pos.x - x0 >= C.BLINK_DIST - 1,
            `dx=${(g.player.pos.x - x0).toFixed(1)}`);
        check('使用後はクールタイムに入る', g.player.blinkCooldown > 0);
        g.input.x = 0;

        const labels = Array.from(document.querySelectorAll('#keyconfig-rows .keyconfig-row span'))
            .map(s => s.textContent).join('|');
        check('キー設定の表記がゼロシフトに変わる', labels.includes('ゼロシフト'), labels);
        check('モバイルボタンは ZERO SHIFT 表記', document.getElementById('btn-blink').textContent.includes('ZERO'));
    });

    // =========================================================
    group('スタイリッシュUI(英語表記)', () => {
        g.reset();
        setMode(1);
        check('モード名が英語表記(STANDARD)', document.getElementById('mode-display').innerText === 'STANDARD');
        setMode(2);
        check('重装は HEAVY と表示', document.getElementById('mode-display').innerText === 'HEAVY');
        check('個性ラベルも英語(DEF=HIGH)', document.getElementById('trait-def').innerText === 'HIGH');
        g.reset();
        check('サブ武器の初期表示は NONE', document.getElementById('sub-name').innerText === 'NONE');
        g.equipSubWeapon('missile');
        check('サブ武器名も英語表記', document.getElementById('sub-name').innerText === 'HOMING MISSILE');
        check('ボス警告も英語表記', document.getElementById('boss-label').textContent.includes('WARNING'));
        check('操作説明(ヘルプ)は日本語のまま', document.querySelector('#help-overlay .guide-heading').textContent === '遊び方');
        g.reset();
    });

    // =========================================================
    group('デバッグモード', () => {
        g.reset();
        g.toggleDebug();
        const panel = document.getElementById('debug-panel');
        check('F2/APIでパネルが表示される', !!panel && panel.style.display !== 'none');

        panel.querySelector('[data-dbg="god"]').click();
        check('GODモードをONにできる', g.debugGod === true);
        g.player.hitInvincible = 0;
        g.damagePlayer(50);
        check('GODモード中はダメージを受けない', g.hp === C.PLAYER_MAX_HP, `hp=${g.hp}`);
        panel.querySelector('[data-dbg="god"]').click();
        check('GODモードをOFFに戻せる', g.debugGod === false);

        const s0 = g.score;
        panel.querySelector('[data-dbg="score"]').click();
        check('スコアを加算できる', g.score === s0 + 1000, `score=${g.score}`);

        panel.querySelector('[data-dbg="boss"]').click();
        check('ボスを即時出現できる', g.boss.active === true);

        g.toggleDebug();
        check('もう一度押すと隠れる', panel.style.display === 'none');
        g.reset();
    });

    // =========================================================
    group('アイテムの取りやすさ(吸い寄せ+判定拡大)', () => {
        g.reset(); setMode(1);
        g.hp = 50; g.updateHpBar();
        g.spawnItem({ x: 120, y: 0, z: 0 }, 'repair');
        const item = g.items.pool.find(i => i.active);
        item.vel.set(0, 0, 0);
        step(60);
        check('離れたアイテムが吸い寄せられて取れる', !item.active && g.hp === 80,
            `hp=${g.hp} active=${item && item.active}`);

        g.reset(); setMode(1);
        g.hp = 50; g.updateHpBar();
        g.spawnItem({ x: C.ITEM_PICKUP_RADIUS - 2, y: 0, z: 0 }, 'repair');
        g.items.pool.find(i => i.active).vel.set(0, 0, 0);
        step(1);
        check('取得半径が広がっている(旧30 → 42)', g.hp === 80, `hp=${g.hp}`);
    });

    // =========================================================
    group('ヘルプ画面のレイアウト', () => {
        const jc = getComputedStyle(document.getElementById('help-overlay')).justifyContent;
        check('上詰めレイアウトで上部が見切れない', jc === 'flex-start', `justify-content=${jc}`);
    });

    // =========================================================
    group('ボス撃破演出(断末魔 → 大爆発)', () => {
        g.reset();
        g.addScore(C.BOSS_FIRST_SCORE);
        step(1, true);
        g.damageBoss(999999);
        check('撃破直後は断末魔シーケンスに入る', g.boss.dying === true && g.boss.mesh.visible === true);
        check('断末魔の間は攻撃・衝突の対象外', g.boss.active === false);

        let frames = 0;
        while (g.boss.dying && frames < 200) {
            g.spawnTimer = 1e9;
            g.update(1 / 60);
            frames++;
        }
        check('約1.5秒(90フレーム)で爆散する', frames >= 85 && frames <= 100, `frames=${frames}`);
        check('本体が消えて衝撃波リングが広がる',
            !g.boss.mesh.visible && g.shockwaveLife > 0 && g.shockwave.visible);
        check('大爆発で強い画面揺れが入る', g.shakeIntensity > 1.0, `shake=${g.shakeIntensity.toFixed(2)}`);
        g.reset();
    });

    // =========================================================
    group('敵タイプの多様化', () => {
        // 蛇行型:左右へ大きく揺れながら接近する
        g.reset();
        const w = g.spawnEnemyUnit('weave');
        w.mesh.position.set(0, 0, -400);
        w.vel.set(0, 0, 0);
        let minVx = Infinity, maxVx = -Infinity;
        for (let i = 0; i < 140 && w.active; i++) {
            g.spawnTimer = 1e9;
            g.nextBossScore = Number.MAX_SAFE_INTEGER;
            g.update(1 / 60);
            minVx = Math.min(minVx, w.vel.x);
            maxVx = Math.max(maxVx, w.vel.x);
        }
        check('蛇行型は左右へ大きく揺れる', minVx < -60 && maxVx > 60,
            `vx=[${minVx.toFixed(0)}, ${maxVx.toFixed(0)}]`);

        // 砲撃型:遠距離から自機を狙って撃つ
        g.reset();
        g.player.hitInvincible = 999;
        const gn = g.spawnEnemyUnit('gunner');
        gn.mesh.position.set(0, 0, -400);
        gn.vel.set(0, 0, 0);
        gn.fireTimer = 0.05;
        for (let i = 0; i < 10; i++) {
            g.spawnTimer = 1e9;
            g.nextBossScore = Number.MAX_SAFE_INTEGER;
            g.update(1 / 60);
        }
        check('砲撃型は弾を撃つ', countActive(g.enemyShots) >= 1, `shots=${countActive(g.enemyShots)}`);
        let toward = false;
        g.enemyShots.forEachActive(s => { if (s.vel.z > 100) toward = true; });
        check('弾は自機の方向(+Z)へ飛ぶ', toward);

        // 出現テーブル:レベル2以降は3タイプが混ざる
        g.reset();
        g.addScore(1650); // レベル2
        const auto1 = withRandom(0.1, () => g.spawnEnemyUnit());
        const auto2 = withRandom(0.4, () => g.spawnEnemyUnit());
        const auto3 = withRandom(0.9, () => g.spawnEnemyUnit());
        check('低乱数で砲撃型が出る(Lv2以降)', auto1.kind === 'gunner', `kind=${auto1.kind}`);
        check('中乱数で蛇行型が出る', auto2.kind === 'weave', `kind=${auto2.kind}`);
        check('高乱数で突撃型が出る', auto3.kind === 'rush', `kind=${auto3.kind}`);
        g.reset();
    });

    // =========================================================
    group('ランキング(ローカル上位5件)', () => {
        localStorage.removeItem(Z.storageKeys.ranking);
        g.gameMode = 'normal';
        g.reset(); g.addScore(500); g.gameOver();
        let arr = JSON.parse(localStorage.getItem(Z.storageKeys.ranking));
        check('初回スコアが記録される', arr.length === 1 && arr[0] === 500, JSON.stringify(arr));
        check('画面にランキングが表示される',
            document.getElementById('ranking-box').style.display === 'block' &&
            document.querySelectorAll('#ranking-list li').length === 1);

        g.reset(); g.addScore(900); g.gameOver();
        g.reset(); g.addScore(300); g.gameOver();
        arr = JSON.parse(localStorage.getItem(Z.storageKeys.ranking));
        check('降順で並ぶ', arr[0] === 900 && arr[1] === 500 && arr[2] === 300, JSON.stringify(arr));

        [1200, 800, 700, 600].forEach(s => { g.reset(); g.addScore(s); g.gameOver(); });
        arr = JSON.parse(localStorage.getItem(Z.storageKeys.ranking));
        check('上位5件だけ保持する', arr.length === 5, `len=${arr.length}`);
        check('最上位が維持される', arr[0] === 1200, JSON.stringify(arr));
        check('今回のスコアが強調表示される', document.querySelector('#ranking-list .rank-new') !== null);

        // チャレンジモードのスコアはランキング対象外
        g.gameMode = 'challenge';
        g.reset(); g.addScore(99999); g.gameOver();
        arr = JSON.parse(localStorage.getItem(Z.storageKeys.ranking));
        check('チャレンジのスコアは記録しない', !arr.includes(99999), JSON.stringify(arr));
        g.gameMode = 'normal';
        g.reset();
    });

    // =========================================================
    group('チャレンジモード(無敵+2分スコアアタック)', () => {
        g.gameMode = 'challenge';
        g.reset();
        check('制限時間120秒で開始する', approx(g.challengeTimeLeft, C.CHALLENGE_TIME, 0.01),
            `t=${g.challengeTimeLeft}`);
        check('残り時間が表示される', document.getElementById('challenge-time').style.display !== 'none');

        g.player.hitInvincible = 0;
        g.damagePlayer(25);
        check('チャレンジ中は被弾しない(無敵)', g.hp === C.PLAYER_MAX_HP, `hp=${g.hp}`);

        // すり抜け:接触しても敵は消えず(タダで処理できない)、敵弾も消えない
        g.player.hitInvincible = 0;
        const eC = spawnEnemy(0, 0, 0);
        placeBossShot(0, 0, 0);
        step(1);
        check('敵に接触しても敵が消えない(すり抜け)', eC.active === true && g.hp === C.PLAYER_MAX_HP,
            `active=${eC.active} hp=${g.hp}`);
        check('敵弾もすり抜けて消えない', countActive(g.enemyShots) === 1,
            `shots=${countActive(g.enemyShots)}`);
        eC.active = false; eC.mesh.visible = false;
        g.enemyShots.forEachActive(s => { s.active = false; s.mesh.visible = false; });

        step(60);
        check('時間が経過で減る', g.challengeTimeLeft < C.CHALLENGE_TIME - 0.9,
            `t=${g.challengeTimeLeft.toFixed(1)}`);

        g.challengeTimeLeft = 0.02;
        step(3);
        check('時間切れで終了する', g.state === 'gameover', `state=${g.state}`);
        check('見出しが TIME UP になる', document.getElementById('gameover-title').innerText === 'TIME UP');
        check('チャレンジではランキングを表示しない', document.getElementById('ranking-box').style.display === 'none');
        check('時間切れでは機体は爆散しない', g.player.group.visible === true);

        g.gameMode = 'normal';
        g.reset();
        check('通常モードでは残り時間が消える', document.getElementById('challenge-time').style.display === 'none');
    });

    // =========================================================
    group('開始レベル選択', () => {
        g.setStartLevel(3);
        g.reset();
        check('開始レベル3で始まる', g.level === 3, `lv=${g.level}`);
        check('HUDのレベル表示も3', document.getElementById('level-display').innerText === '3');
        check('タイトルの表示が更新される', document.getElementById('start-level-val').innerText === '3');
        g.addScore(C.SCORE_PER_LEVEL);
        check('スコア加算で開始レベルから上がる', g.level === 4, `lv=${g.level}`);

        g.cycleStartLevel(); // 3 → 5
        check('選択は 1→3→5 で循環する', g.startLevel === 5);
        g.cycleStartLevel(); // 5 → 1
        check('5の次は1へ戻る', g.startLevel === 1);
        g.reset();
    });

    // =========================================================
    group('タイトルへ戻る', () => {
        g.gameMode = 'normal';
        g.reset();
        g.gameOver();
        document.getElementById('to-title').click();
        check('タイトル画面に戻る', g.state === 'title' &&
            document.getElementById('start-overlay').style.display === 'flex');
        document.querySelector('#start-overlay .start-btn').click();
        check('タイトルから再開できる', g.state === 'playing' &&
            document.getElementById('start-overlay').style.display === 'none');
    });

    // =========================================================
    group('ブースト(押している間だけ加速・無敵/ゲージなし)', () => {
        // 方向キー+ブーストで、通常移動より明確に速く加速する
        g.reset(); setMode(1);
        g.input.x = 1; g.input.y = 0; g.input.boost = false;
        step(8);
        const normalVx = g.player.vel.x;

        g.reset(); setMode(1);
        g.input.x = 1; g.input.y = 0; g.input.boost = true;
        step(8);
        const boostVx = g.player.vel.x;
        check('方向キー+ブーストで通常より高速に加速する', boostVx > normalVx * 1.5,
            `normal=${normalVx.toFixed(0)} boost=${boostVx.toFixed(0)}`);
        check('エネルギー制は廃止されている', g.player.boostEnergy === undefined);
        g.input.boost = false; g.input.x = 0;

        // 方向キーなしのブーストは前方の流れ(星)を加速させる
        g.reset();
        g.jerkIntensity = 0;
        const starPos = g.stars.geometry.attributes.position;
        starPos.setZ(0, -100);
        g.input.x = 0; g.input.y = 0; g.input.boost = false;
        step(1);
        const dNo = starPos.getZ(0) - (-100);

        g.jerkIntensity = 0;
        starPos.setZ(0, -100);
        g.input.boost = true;
        step(1);
        const dBoost = starPos.getZ(0) - (-100);
        check('方向キーなしでも前方の流れが速くなる(前方高速移動)', dBoost > dNo * 1.5,
            `noboost=${dNo.toFixed(1)} boost=${dBoost.toFixed(1)}`);

        // 押しっぱなしでも切れない(時間制限なし)
        step(300); // 5秒間押しっぱなし
        check('押している間はずっと加速し続けられる', g.player.isBoosting === true);
        g.input.boost = false;

        // 無敵は廃止:ブースト中でも被弾する
        g.reset(); setMode(1);
        g.player.hitInvincible = 0;
        g.input.boost = true;
        spawnEnemy(0, 0, 0);
        step(1);
        check('ブースト中でも被弾する(無敵廃止)', g.hp < C.PLAYER_MAX_HP, `hp=${g.hp}`);
        g.input.boost = false;

        // ゲージUIが撤去されている
        check('ブーストゲージのUIが無い', !document.getElementById('boost-fill'));
        g.reset();
    });

    // =========================================================
    group('HUDパネルの表示崩れ防止', () => {
        // 初期状態(STANDARD / DEF:MID / ROF:MID / PWR:MID)で
        // PWRチップがパネル枠の右端をはみ出さないこと
        g.reset(); setMode(1);
        const panel = document.querySelector('#ui-layer .panel');
        const pwrChip = document.getElementById('trait-pow').parentElement;
        const pRect = panel.getBoundingClientRect();
        const cRect = pwrChip.getBoundingClientRect();
        check('PWRラベルが枠の右端をはみ出さない', cRect.right <= pRect.right + 0.5,
            `chip.right=${cRect.right.toFixed(1)} panel.right=${pRect.right.toFixed(1)}`);

        // HEAVY(最長のモード名)でもはみ出さない
        setMode(2);
        const pwrChip2 = document.getElementById('trait-pow').parentElement;
        check('HEAVY表示でもPWRチップが枠内に収まる',
            pwrChip2.getBoundingClientRect().right <= panel.getBoundingClientRect().right + 0.5);
        g.reset();
    });

    // =========================================================
    group('起動時はタイトル状態', () => {
        check('起動直後はtitle状態で、タイトルの裏でゲームが進まない',
            stateAtBoot === 'title', `state=${stateAtBoot}`);
    });

    // =========================================================
    group('ショット進化(撃破数でツイン/トリプル)', () => {
        g.reset();
        check('初期はシングルショット', g.shotLevel === 1 &&
            document.getElementById('gun-level').innerText === 'SINGLE');

        g.lastFireTime = 0; g.input.fire = true; step(1); g.input.fire = false;
        check('シングルでは1発だけ発射', countActive(g.bullets) === 1, `弾=${countActive(g.bullets)}`);

        // 15機目の撃破でツインへ
        g.reset();
        g.killCount = C.TWIN_SHOT_KILLS - 1;
        withRandom(0.99, () => g.destroyEnemy(spawnEnemy(0, 0, -300, 1)));
        check('15機撃破でツインショットへ進化', g.shotLevel === 2, `kills=${g.killCount}`);
        check('HUD表示がTWINになる', document.getElementById('gun-level').innerText === 'TWIN');

        g.lastFireTime = 0; g.input.fire = true; step(1); g.input.fire = false;
        check('ツインでは2発が同時発射', countActive(g.bullets) === 2, `弾=${countActive(g.bullets)}`);
        const xs = [];
        g.bullets.forEachActive(b => xs.push(b.mesh.position.x));
        check('2発は左右へ分かれて並ぶ', xs.length === 2 && xs[0] !== xs[1], `xs=${xs.map(x => x.toFixed(0))}`);

        // 40機目の撃破でトリプルへ
        g.reset();
        g.killCount = C.TRIPLE_SHOT_KILLS - 1;
        withRandom(0.99, () => g.destroyEnemy(spawnEnemy(0, 0, -300, 1)));
        check('40機撃破でトリプルショットへ進化', g.shotLevel === 3, `kills=${g.killCount}`);
        check('HUD表示がTRIPLEになる', document.getElementById('gun-level').innerText === 'TRIPLE');

        g.lastFireTime = 0; g.input.fire = true; step(1); g.input.fire = false;
        check('トリプルでは3発が同時発射', countActive(g.bullets) === 3, `弾=${countActive(g.bullets)}`);

        g.reset();
        check('リスタートでシングルへ戻る', g.shotLevel === 1 &&
            document.getElementById('gun-level').innerText === 'SINGLE');
    });

    // =========================================================
    group('連続撃破コンボ', () => {
        g.reset();
        withRandom(0.99, () => {
            g.destroyEnemy(spawnEnemy(0, 0, -300, 1));
            g.destroyEnemy(spawnEnemy(0, 0, -300, 1));
        });
        check('連続撃破でコンボが増える', g.combo === 2, `combo=${g.combo}`);
        check('2機目からボーナスが乗る(100+110点)', g.score === 210, `score=${g.score}`);

        step(Math.ceil(C.COMBO_WINDOW * 60) + 5);
        check('時間が空くとコンボが途切れる', g.combo === 0, `combo=${g.combo}`);

        withRandom(0.99, () => g.destroyEnemy(spawnEnemy(0, 0, -300, 1)));
        check('途切れた後は1から再開する', g.combo === 1);

        setMode(1);
        g.player.hitInvincible = 0;
        g.damagePlayer(10);
        check('被弾でコンボが途切れる', g.combo === 0, `combo=${g.combo}`);
        g.reset();
    });

    // =========================================================
    group('ロックオン後の硬直短縮', () => {
        check('硬直時間の定数が短縮されている(0.3 → 0.12)', C.VOLLEY_FREEZE === 0.12,
            `freeze=${C.VOLLEY_FREEZE}`);
        g.reset();
        spawnEnemy(0, 0, -300);
        g.input.lock = true;
        step(30);
        g.input.lock = false;
        step(1);
        check('発射直後の硬直が短い', g.player.freezeTimer > 0 && g.player.freezeTimer <= C.VOLLEY_FREEZE,
            `freeze=${g.player.freezeTimer.toFixed(3)}`);
        g.reset();
    });

    // =========================================================
    group('効果音のスパム防止', () => {
        const a = g.audio;
        if (!a.isInitialized) {
            check('(音声が未初期化のため検証をスキップ)', true);
            return;
        }
        a.lastExplosionTime = -999;
        const p1 = a.playExplosion();
        const p2 = a.playExplosion();
        check('爆発音は最小間隔(0.12秒)で間引かれる', p1 === true && p2 === false,
            `p1=${p1} p2=${p2}`);
    });

    // =========================================================
    group('ウィスプ(支援ビット)', () => {
        g.reset();
        check('初期はウィスプなし', g.wispCount === 0 &&
            document.getElementById('wisp-count').innerText === 'NONE');

        // 100機目の撃破で1機目を装備する
        g.killCount = C.WISP_KILLS_PER - 1;
        withRandom(0.99, () => g.destroyEnemy(spawnEnemy(0, 0, -300, 1)));
        check('100機撃破で1機装備', g.wispCount === 1, `wisp=${g.wispCount}`);
        check('HUD表示が ×1 になる', document.getElementById('wisp-count').innerText === '×1');

        step(1);
        check('装備したウィスプだけが表示される',
            g.wisps[0].visible === true && g.wisps[1].visible === false && g.wisps[2].visible === false);
        check('1秒ごとに単発弾を撃つ(装備直後の初弾)', countActive(g.bullets) === 1,
            `弾=${countActive(g.bullets)}`);
        check('発射後はタイマーが約1秒に再設定される',
            g.wispFireTimer > 0.9 && g.wispFireTimer <= C.WISP_FIRE_INTERVAL,
            `t=${g.wispFireTimer.toFixed(2)}`);

        step(30);
        const d = g.wisps[0].position.distanceTo(g.player.pos);
        check('機体の近くに追従する', d < 60, `d=${d.toFixed(0)}`);

        // 300機撃破で3機到達、各機が1発ずつ撃つ
        g.reset();
        g.killCount = C.WISP_KILLS_PER * 3 - 1;
        withRandom(0.99, () => g.destroyEnemy(spawnEnemy(0, 0, -300, 1)));
        check('300機撃破で3機に到達', g.wispCount === 3, `wisp=${g.wispCount}`);
        g.bullets.forEachActive(b => { b.active = false; b.mesh.visible = false; });
        g.wispFireTimer = 0;
        step(1);
        check('3機がそれぞれ1発ずつ撃つ', countActive(g.bullets) === 3, `弾=${countActive(g.bullets)}`);

        // 上限は3機
        g.killCount = C.WISP_KILLS_PER * 5;
        withRandom(0.99, () => g.destroyEnemy(spawnEnemy(0, 0, -300, 1)));
        check('最大3機を超えない', g.wispCount === C.WISP_MAX, `wisp=${g.wispCount}`);

        g.reset();
        check('リスタートで解除される', g.wispCount === 0 && g.wisps[0].visible === false &&
            document.getElementById('wisp-count').innerText === 'NONE');
    });

    // =========================================================
    group('ロックオンレーザーの新仕様(固定24発・威力3割)', () => {
        check('威力が約3割へ引き下げ(2.0 → 0.6)', C.LASER_DAMAGE === 0.6, `dmg=${C.LASER_DAMAGE}`);
        check('発射本数は24で固定', C.VOLLEY_COUNT === 24, `n=${C.VOLLEY_COUNT}`);

        // 2ロックでも24発、対象へ均等に振り分けられる
        g.reset();
        const eA = spawnEnemy(-40, 0, -300, 999);
        const eB = spawnEnemy(40, 0, -300, 999);
        g.input.lock = true;
        step(30);
        g.input.lock = false;
        step(1);
        check('2ロックでも24発発射される', countActive(g.homingLasers) === C.VOLLEY_COUNT,
            `弾=${countActive(g.homingLasers)}`);
        let atA = 0, atB = 0;
        g.homingLasers.forEachActive(l => {
            if (l.target === eA) atA++;
            else if (l.target === eB) atB++;
        });
        check('レーザーが対象へ均等に振り分けられる', atA === 12 && atB === 12, `A=${atA} B=${atB}`);

        // 1発の威力では耐久1の敵も一撃で落ちない
        g.reset();
        const e = spawnEnemy(0, 0, -300, 1);
        g.launchProjectile(g.homingLasers, 0, 0, -300, 0, 0, 0, e, 0, 4, C.LASER_DAMAGE);
        step(1);
        check('威力0.6では耐久1を一撃で倒せない', e.active && approx(e.hp, 0.4, 0.01),
            `hp=${e.hp.toFixed(2)} active=${e.active}`);
        g.reset();
    });

    // =========================================================
    group('グレイズ(すれすれ回避ボーナス)', () => {
        g.reset(); setMode(1);
        g.player.hitInvincible = 0;
        // 接触半径(size10+自機9=19)の外・グレイズ帯(+26=45)の内に敵を置く
        const e = spawnEnemy(40, 0, 0);
        e.grazed = false;
        step(1);
        check('すれすれ通過でボーナス点が入る', g.score === C.GRAZE_SCORE, `score=${g.score}`);
        check('被弾はしていない', g.hp === C.PLAYER_MAX_HP, `hp=${g.hp}`);
        check('グレイズ演出が光る', g.grazeFlash > 0, `flash=${g.grazeFlash.toFixed(2)}`);

        step(1);
        check('同じ敵からは1回だけ', g.score === C.GRAZE_SCORE, `score=${g.score}`);
        e.active = false; e.mesh.visible = false;
        g.reset();
    });

    // =========================================================
    group('ニューレコード表示', () => {
        localStorage.removeItem(Z.storageKeys.best);
        g.gameMode = 'normal';
        g.reset();
        g.addScore(500);
        g.gameOver();
        check('ベスト更新時に NEW RECORD が表示される',
            document.getElementById('new-record').style.display !== 'none');

        g.reset();
        g.addScore(10);
        g.gameOver();
        check('更新できなければ表示されない',
            document.getElementById('new-record').style.display === 'none');
        g.reset();
    });

    // =========================================================
    group('遊びやすさ調整: 敵の軌道確定(近距離ホーミング停止)', () => {
        g.reset();
        // 遠距離(z < -120)ではホーミングが働く
        const far = spawnEnemy(0, 100, -300);
        step(1);
        check('遠距離では自機へ寄ってくる', far.vel.y < 0, `vy=${far.vel.y.toFixed(2)}`);
        far.active = false; far.mesh.visible = false;

        // 近距離(z > -120)では軌道が確定し、吸い付かない
        const near = spawnEnemy(0, 100, -60);
        step(1);
        check('近距離ではホーミングしない(回避が読める)', near.vel.y === 0, `vy=${near.vel.y}`);
        near.active = false; near.mesh.visible = false;

        // 蛇行型も近距離では横っ飛びをやめて直進する
        const wv = g.spawnEnemyUnit('weave');
        wv.mesh.position.set(0, 100, -60);
        wv.vel.set(50, 0, 0);
        wv.grazed = true;
        step(1);
        check('蛇行型も近距離では直進に移る', wv.vel.x === 50, `vx=${wv.vel.x}`);
        wv.active = false; wv.mesh.visible = false;
        g.reset();
    });

    // =========================================================
    group('遊びやすさ調整: 当たり判定の縮小', () => {
        check('自機の実効判定は半径9', C.PLAYER_HIT_RADIUS === 9, `r=${C.PLAYER_HIT_RADIUS}`);

        // 旧判定(22)なら接触していた距離21では、新判定(19)では当たらない
        g.reset(); setMode(1);
        g.player.hitInvincible = 0;
        const e = spawnEnemy(21, 0, 0);
        step(1);
        check('距離21(旧判定なら被弾)ではかすらない', g.hp === C.PLAYER_MAX_HP && e.active,
            `hp=${g.hp} active=${e.active}`);

        // 新判定の内側ではきちんと当たる
        e.mesh.position.set(15, 0, 0);
        step(1);
        check('判定内(距離15)では被弾する', g.hp < C.PLAYER_MAX_HP, `hp=${g.hp}`);
        g.reset();
    });

    // =========================================================
    group('遊びやすさ調整: 硬直と壁の手触り', () => {
        // 硬直中は速度がゼロにならず、減衰しながら滑る(慣性の余韻)
        g.reset(); setMode(1);
        g.player.vel.set(400, 0, 0);
        g.player.freezeTimer = 0.1;
        step(1);
        check('硬直中も慣性が残る(完全停止しない)',
            g.player.vel.x > 0 && g.player.vel.x < 400, `vx=${g.player.vel.x.toFixed(0)}`);

        // 壁の反発は弱め(-25%)
        g.reset(); setMode(1);
        g.player.pos.x = C.BOUND_X;
        g.player.vel.x = 200;
        step(1);
        check('壁の反発が穏やか(強く弾き返されない)',
            g.player.vel.x < 0 && Math.abs(g.player.vel.x) <= 200 * 0.3,
            `vx=${g.player.vel.x.toFixed(0)}`);
        g.reset();
    });

    // ---------- 後片付け:テスト後は静止させておく ----------
    g.reset();
    g.state = 'paused';

    // =========================================================
    // 結果の集計と表示
    // =========================================================
    let passed = 0, failed = 0;
    const failures = [];
    groups.forEach(gr => gr.cases.forEach(c => {
        if (c.ok) passed++;
        else { failed++; failures.push(`[${gr.name}] ${c.name} — ${c.detail}`); }
    }));
    const total = passed + failed;

    window.__testResults = { total, passed, failed, failures };
    console.log(`GRAVITY ZERO テスト: ${passed}/${total} 成功` + (failed ? ` / ${failed} 失敗` : ''));
    failures.forEach(f => console.error('FAIL: ' + f));

    renderReport(groups, { total, passed, failed });
}

/** 結果を画面に描画する */
function renderReport(groups, sum) {
    const root = document.getElementById('test-report');
    root.innerHTML = '';

    const h1 = document.createElement('h1');
    h1.textContent = 'GRAVITY ZERO — テストスイート';
    root.appendChild(h1);

    const summary = document.createElement('div');
    summary.id = 'test-summary';
    summary.className = sum.failed === 0 ? 'pass' : 'fail';
    summary.textContent = sum.failed === 0
        ? `✅ 全 ${sum.total} 件 成功`
        : `❌ ${sum.passed}/${sum.total} 成功 ・ ${sum.failed} 件 失敗`;
    root.appendChild(summary);

    groups.forEach(gr => {
        const g = document.createElement('div');
        g.className = 'test-group';
        const okCount = gr.cases.filter(c => c.ok).length;
        g.textContent = `${gr.name}  (${okCount}/${gr.cases.length})`;
        root.appendChild(g);
        gr.cases.forEach(c => {
            const d = document.createElement('div');
            d.className = 'test-case ' + (c.ok ? 'ok' : 'ng');
            d.innerHTML = (c.ok ? '✓ ' : '✗ ') + c.name +
                (c.detail ? ` <span class="detail">(${c.detail})</span>` : '');
            root.appendChild(d);
        });
    });
}

/** window.game と window.ZMF が用意できてから実行する */
function waitAndRun(attempt = 0) {
    if (window.game && window.ZMF) {
        // タブが非表示でも実行できるよう、rAFではなくタイマーで開始する
        setTimeout(() => runAll(), 50);
        return;
    }
    if (attempt > 200) {
        document.getElementById('test-report').innerHTML =
            '<h1 style="color:#ff8095">ゲーム本体の読み込みに失敗しました</h1>';
        return;
    }
    setTimeout(() => waitAndRun(attempt + 1), 20);
}

window.addEventListener('load', () => waitAndRun());
