import { today, nextWeek, slots, legacyKey, validate, readBackup, deduplicate, sameRecord, totals, csvCell } from './model.mjs';

const $ = id => document.getElementById(id);
const notify = message => { $('message').textContent = message; };
const money = value => 'NT$' + value.toLocaleString('zh-TW');
const slotLabel = { am: '早上', pm: '晚上' };
const statusLabel = { pending: '待司機確認', accepted: '已確認', rejected: '無法配合' };
const dayLabel = new Intl.DateTimeFormat('zh-TW', { weekday: 'short', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
const weekdayLabel = new Intl.DateTimeFormat('zh-TW', { weekday: 'short', timeZone: 'UTC' });
let auth, db, api, role, editing;
let bookings = new Map();
let records = [];
let listeners = [];
let session = 0;
let bookingsReady = false;
let recordsReady = false;
let weekDirty = false;

function showPage(page, moveFocus = false) {
  for (const name of ['schedule', 'ledger']) {
    const active = page === name;
    $(name + 'Page').hidden = !active;
    $(name + 'Nav').setAttribute('aria-pressed', String(active));
  }
  if (moveFocus) {
    $(page + 'Nav').focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
}

$('scheduleNav').onclick = $('previousPage').onclick = () => showPage('schedule', true);
$('ledgerNav').onclick = $('nextPage').onclick = () => showPage('ledger', true);

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function button(label, handler) {
  const node = element('button', label);
  node.type = 'button';
  node.onclick = () => perform(node, handler);
  return node;
}

async function perform(control, handler) {
  control.disabled = true;
  try {
    await handler();
  } catch (error) {
    const messages = {
      'permission-denied': '此帳號沒有執行這項操作的權限。',
      'auth/invalid-credential': '電子郵件或密碼有誤。',
      'auth/network-request-failed': '連線失敗，請檢查網路後重試。',
      unavailable: '目前無法連到 Firebase，請稍後再試。'
    };
    notify(messages[error.code] ?? error.message);
  } finally {
    control.disabled = false;
  }
}

const bookingRef = id => api.doc(db, 'petShuttleBookings', id);
const recordRef = id => api.doc(db, 'petShuttleRecords', id);
const revision = row => row?.revision ?? 0;

function renderBookings() {
  weekDirty = false;
  const host = $('bookings');
  host.replaceChildren();
  if (!bookingsReady) {
    host.textContent = '正在載入預約…';
    return;
  }
  if (role === 'driver') {
    const rows = [...bookings.entries()].filter(([, row]) => row.date >= today() && row.status !== 'cancelled')
      .sort(([a], [b]) => a.localeCompare(b));
    if (!rows.length) host.textContent = '目前沒有接下來的接送預約。';
    for (const [id, row] of rows) {
      const article = element('article');
      article.append(element('strong', row.date + ' · ' + slotLabel[row.slot]),
        element('p', (row.car ? '須開車' : '機車') + ' · ' + statusLabel[row.status]));
      if (row.status === 'pending') {
        const actions = element('div', '', 'actions');
        for (const [status, label] of [['accepted', '確認'], ['rejected', '無法配合']]) {
          actions.append(button(label, async () => {
            await api.runTransaction(db, async tx => {
              const ref = bookingRef(id);
              const current = (await tx.get(ref)).data();
              if (revision(current) !== row.revision) throw new Error('需求已變更，請重新查看。');
              tx.update(ref, { status, revision: row.revision + 1 });
            });
            notify(status === 'accepted' ? '預約已確認。' : '已標記為無法配合。');
          }));
        }
        article.append(actions);
      }
      host.append(article);
    }
    return;
  }

  const days = nextWeek();
  $('bookingTitle').textContent = '下週需求 · ' + days[0].slice(5) + ' 至 ' + days[6].slice(5);
  const fields = [];
  for (const date of days) {
    const article = element('article');
    const grid = element('div', '', 'grid');
    article.append(element('strong', dayLabel.format(new Date(date + 'T00:00:00Z'))), grid);
    const car = element('input');
    car.type = 'checkbox';
    car.setAttribute('role', 'switch');
    car.onchange = () => { weekDirty = true; };
    const carCopy = element('span', '須開車');
    carCopy.append(element('small', '預設為機車接送'));
    const carLabel = element('label', '', 'car');
    carLabel.append(carCopy, car);
    const dayFields = [];
    for (const slot of slots) {
      const id = date + '_' + slot;
      const row = bookings.get(id);
      const ride = element('div', '', 'ride');
      const pick = element('input');
      pick.type = 'checkbox';
      pick.checked = !!row && row.status !== 'cancelled';
      const pickLabel = element('label', slotLabel[slot]);
      pickLabel.prepend(pick);
      const status = element('small', statusLabel[row?.status]);
      status.hidden = !pick.checked;
      pick.onchange = () => {
        weekDirty = true;
        status.hidden = !pick.checked;
        car.disabled = !dayFields.some(field => field.pick.checked);
        if (car.disabled) car.checked = false;
      };
      ride.append(pickLabel, status);
      grid.append(ride);
      dayFields.push({ id, date, slot, row, pick, car });
    }
    car.disabled = !dayFields.some(field => field.pick.checked);
    car.checked = dayFields.some(field => field.pick.checked && field.row?.car);
    car.setAttribute('aria-label', '須開車');
    fields.push(...dayFields);
    article.append(carLabel);
    host.append(article);
  }
  $('saveWeek').onclick = () => perform($('saveWeek'), async () => {
    const changes = fields.flatMap(({ id, date, slot, row, pick, car }) => {
      const active = !!row && row.status !== 'cancelled';
      if (pick.checked === active && (!active || car.checked === row.car)) return [];
      return [{ ref: bookingRef(id), expected: revision(row), data: {
        date, slot, car: pick.checked && car.checked,
        status: pick.checked ? 'pending' : 'cancelled', revision: revision(row) + 1
      } }];
    });
    if (!changes.length) {
      renderBookings();
      return notify('沒有變更。');
    }
    if (nextWeek()[0] !== days[0]) {
      renderBookings();
      throw new Error('已進入新的一週，請重新選擇。');
    }
    await api.runTransaction(db, async tx => {
      const snapshots = await Promise.all(changes.map(change => tx.get(change.ref)));
      for (const [index, change] of changes.entries()) {
        if (revision(snapshots[index].data()) !== change.expected) {
          renderBookings();
          throw new Error('預約已更新，請重新查看後儲存。');
        }
      }
      for (const { ref, data } of changes) tx.set(ref, data);
    });
    renderBookings();
    notify('下週需求已儲存。');
  });
}

function selectedRecords() {
  return records.filter(row => row.date.startsWith($('month').value + '-'))
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
}

function syncFee() {
  $('fee').readOnly = $('period').value !== '白天';
  $('fee').value = $('fee').readOnly ? 250 : '';
}

function resetEntry() {
  editing = null;
  $('entry').reset();
  $('date').value = today();
  $('formTitle').textContent = '新增接送';
  $('save').textContent = '新增紀錄';
  $('cancel').hidden = true;
  syncFee();
}

function edit(row) {
  editing = row;
  for (const key of ['date', 'time', 'period', 'note']) $(key).value = row[key];
  syncFee();
  $('fee').value = row.fee;
  $('formTitle').textContent = '編輯接送';
  $('save').textContent = '儲存修改';
  $('cancel').hidden = false;
  $('date').focus();
}

async function changeRecord(original, replacement) {
  const ref = recordRef(original?.id ?? replacement.id);
  await api.runTransaction(db, async tx => {
    const existing = (await tx.get(ref)).data();
    if (original ? !existing || !sameRecord(existing, original) : !!existing) {
      throw new Error('這筆紀錄已更新，請重新查看。');
    }
    if (replacement) tx.set(ref, replacement);
    else tx.delete(ref);
  });
}

function renderRecords() {
  const list = $('records');
  list.replaceChildren();
  const rows = selectedRecords();
  const summary = totals(rows);
  $('trips').textContent = recordsReady ? summary.trips : '—';
  $('income').textContent = recordsReady ? money(summary.fee) : '—';
  $('csv').disabled = $('backup').disabled = !recordsReady;
  if (!rows.length) list.textContent = recordsReady ? '這個月還沒有接送紀錄。' : '正在載入紀錄…';
  for (const row of rows) {
    const article = element('article');
    const weekday = weekdayLabel.format(new Date(row.date + 'T00:00:00Z'));
    article.append(element('strong', [row.date + '（' + weekday + '）', row.time, row.period].join(' · ')),
      element('p', money(row.fee) + (row.note ? '\n' + row.note : '')));
    if (role === 'driver') {
      const actions = element('div', '', 'actions');
      actions.append(button('編輯', () => edit(row)), button('刪除', async () => {
        if (!confirm('刪除 ' + row.date + ' ' + row.time + ' 的接送紀錄？')) return;
        await changeRecord(row, null);
        if (editing?.id === row.id) resetEntry();
        notify('已刪除紀錄。');
      }));
      article.append(actions);
    }
    list.append(article);
  }
}

function download(name, type, contents) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = element('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function jsonBackup(rows) {
  return JSON.stringify({ version: 1, records: rows }, null, 2);
}

async function importRecords(rows) {
  const summary = totals(rows);
  if (!rows.length) return notify('備份沒有接送紀錄。');
  if (!confirm(`核對備份：${summary.trips} 筆、${money(summary.fee)}。是否匯入？`)) return;
  if (rows.length > 500) throw new Error('單次請匯入最多 500 筆，以便整批核對。');
  const added = await api.runTransaction(db, async tx => {
    const refs = rows.map(row => recordRef(row.id));
    const snapshots = await Promise.all(refs.map(ref => tx.get(ref)));
    let count = 0;
    for (const [index, snap] of snapshots.entries()) {
      if (snap.exists()) {
        if (!sameRecord(snap.data(), rows[index])) throw new Error('雲端已有相同 ID 的不同紀錄：' + snap.id);
      } else {
        tx.set(refs[index], rows[index]);
        count++;
      }
    }
    return count;
  });
  $('month').value = rows.map(row => row.date).sort().at(-1).slice(0, 7);
  renderRecords();
  notify(`已核對 ${summary.trips} 筆、${money(summary.fee)}。新增 ${added} 筆，略過 ${rows.length - added} 筆相同紀錄。`);
}

$('entry').onsubmit = event => {
  event.preventDefault();
  perform($('save'), async () => {
    const row = validate({
      id: editing?.id ?? crypto.randomUUID(), date: $('date').value,
      time: $('time').value, period: $('period').value, fee: $('fee').valueAsNumber,
      ...(editing?.dogs === undefined ? {} : { dogs: editing.dogs }), note: $('note').value
    });
    await changeRecord(editing, row);
    $('month').value = row.date.slice(0, 7);
    resetEntry();
    renderRecords();
    notify('接送紀錄已儲存。');
  });
};
$('period').onchange = syncFee;
$('cancel').onclick = resetEntry;
$('month').onchange = renderRecords;
$('csv').onclick = () => {
  const rows = [['日期', '時間', '時段', '費用（NT$）', '備註'],
    ...selectedRecords().map(row => [row.date, row.time, row.period, row.fee, row.note])];
  download('接送紀錄-' + $('month').value + '.csv', 'text/csv;charset=utf-8',
    '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'));
};
$('backup').onclick = () => download('毛孩接送備份-' + today() + '.json', 'application/json', jsonBackup(records));
$('restore').onclick = () => $('file').click();
$('file').onchange = () => {
  const file = $('file').files[0];
  $('file').value = '';
  if (file) perform($('restore'), async () => importRecords(readBackup(await file.text())));
};
$('localBackup').onclick = () => perform($('localBackup'), () => {
  const value = localStorage.getItem(legacyKey);
  if (value === null) return notify('此瀏覽器沒有舊版接送紀錄。');
  download('毛孩接送舊版原始備份-' + today() + '.json', 'application/json',
    '{"version":1,"records":' + value + '}');
  const summary = totals(deduplicate(JSON.parse(value)));
  notify(`舊版備份已下載。共 ${summary.trips} 筆、${money(summary.fee)}。`);
});

async function connect(user) {
  const current = ++session;
  listeners.forEach(stop => stop());
  listeners = [];
  records = [];
  bookings = new Map();
  bookingsReady = recordsReady = false;
  role = null;
  $('workspace').hidden = true;
  $('loginPanel').hidden = !!user;
  $('login').reset();
  if (!user) return notify('');
  notify('正在檢查帳號權限…');
  const permission = await api.getDocFromServer(api.doc(db, 'petShuttleRoles', user.uid));
  if (current !== session) return;
  role = permission.data()?.role;
  if (!['driver', 'customer'].includes(role)) {
    $('loginPanel').hidden = false;
    return notify('此帳號尚未分配接送角色。');
  }
  $('role').textContent = role === 'driver' ? '司機' : '客戶';
  $('bookingTitle').textContent = '接送預約';
  $('saveWeek').hidden = true;
  for (const id of ['recordEditor', 'restore', 'localBackup']) $(id).hidden = role !== 'driver';
  $('month').value = today().slice(0, 7);
  resetEntry();
  renderBookings();
  renderRecords();
  showPage('schedule');
  $('workspace').hidden = false;
  notify('');
  const onError = error => notify('同步失敗。' + error.message);
  listeners = [
    api.onSnapshot(api.collection(db, 'petShuttleBookings'), snapshot => {
      bookings = new Map(snapshot.docs.map(doc => [doc.id, doc.data()]));
      bookingsReady = true;
      $('saveWeek').hidden = role !== 'customer';
      if (!weekDirty) renderBookings();
    }, onError),
    api.onSnapshot(api.collection(db, 'petShuttleRecords'), snapshot => {
      records = snapshot.docs.map(doc => doc.data());
      recordsReady = true;
      renderRecords();
    }, onError)
  ];
}

try {
  const base = 'https://www.gstatic.com/firebasejs/11.10.0/';
  const [firebase, identity, firestore] = await Promise.all([
    import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'), import(base + 'firebase-firestore.js')
  ]);
  const app = firebase.initializeApp({
    apiKey: 'AIzaSyDfM0pgmaTGnvDto_4K0gcva9bFyiZJiUU',
    authDomain: 'pet-shuttle.firebaseapp.com',
    projectId: 'pet-shuttle',
    appId: '1:887482342820:web:ac5ecf7a53d9402e0bb531'
  });
  api = firestore;
  auth = identity.getAuth(app);
  db = firestore.getFirestore(app);
  $('login').onsubmit = event => {
    event.preventDefault();
    perform(event.submitter, () => identity.signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value));
  };
  $('logout').onclick = () => perform($('logout'), () => identity.signOut(auth));
  identity.onAuthStateChanged(auth, user => connect(user).catch(error => {
    $('loginPanel').hidden = false;
    notify('無法驗證帳號權限。' + error.message);
  }));
} catch (error) {
  notify('無法啟動雲端連線。請檢查網路後重新載入，或使用舊版接送記帳。');
  console.error(error);
}
