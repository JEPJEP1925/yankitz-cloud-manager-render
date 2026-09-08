function escapeHtml(str) {
    if (str === undefined || str === null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderShareModal(fileName = "resume.jpg") {
    let existingModal = document.getElementById('customShareModal');
    if (existingModal) existingModal.remove();

    const safeFileName = escapeHtml(fileName);

    const modalHTML = `
    <div id="customShareModal" style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
        <div style="background:#fff; border-radius:12px; width:440px; padding:24px; box-shadow:0 20px 25px -5px rgba(0,0,0,0.2); color:#1e293b;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                <h3 style="margin:0; font-size:1.15rem; font-weight:700; color:#0f172a; display:flex; align-items:center; gap:8px;">
                    <span style="color:#2563eb;">&#128279;</span> Share File
                </h3>
                <button onclick="closeCustomShareModal()" style="background:none; border:none; font-size:1.2rem; cursor:pointer; color:#64748b;">&#10005;</button>
            </div>
            
            <p style="margin:0 0 16px 0; font-size:0.875rem; color:#64748b;">File: <strong>${safeFileName}</strong></p>

            <!-- Sharing Tabs -->
            <div style="display:flex; gap:6px; background:#f1f5f9; padding:4px; border-radius:8px; margin-bottom:16px;">
                <button type="button" class="tab-btn active" onclick="switchTab('family', this)" style="flex:1; padding:6px; border:none; border-radius:6px; background:#fff; color:#2563eb; font-weight:600; font-size:0.8rem; cursor:pointer; box-shadow:0 1px 2px rgba(0,0,0,0.05);">Family</button>
                <button type="button" class="tab-btn" onclick="switchTab('public', this)" style="flex:1; padding:6px; border:none; border-radius:6px; background:transparent; color:#64748b; font-weight:500; font-size:0.8rem; cursor:pointer;">Public Link</button>
                <button type="button" class="tab-btn" onclick="switchTab('private', this)" style="flex:1; padding:6px; border:none; border-radius:6px; background:transparent; color:#64748b; font-weight:500; font-size:0.8rem; cursor:pointer;">Private Link</button>
            </div>

            <!-- Tab 1: Family Member -->
            <div id="tab-family" class="tab-panel">
                <div style="margin-bottom:12px;">
                    <label style="font-size:0.875rem; color:#334155; cursor:pointer; display:flex; align-items:center; gap:8px;">
                        <input type="checkbox" id="shareVaultCheck" checked style="accent-color:#2563eb; width:16px; height:16px;"> Share to Family Vault
                    </label>
                </div>
                <div style="margin-bottom:16px;">
                    <label style="display:block; font-size:0.75rem; font-weight:700; color:#64748b; text-transform:uppercase; margin-bottom:6px;">Share With</label>
                    <select id="familyMemberSelect" style="width:100%; padding:8px 12px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.875rem; color:#1e293b; background:#fff;">
                        <option value="">Select Member</option>
                        <option value="Rey">Rey</option>
                        <option value="lanz">lanz</option>
                        <option value="jep">jep</option>
                        <option value="ohda">ohda</option>
                    </select>
                </div>
            </div>

            <!-- Tab 2: Public Link -->
            <div id="tab-public" class="tab-panel" style="display:none;">
                <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:0.75rem; font-weight:700; color:#64748b; text-transform:uppercase; margin-bottom:6px;">Link</label>
                    <input type="text" readonly value="https://cloud.yankitz.com/s/A8F93KLM" style="width:100%; padding:8px 12px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.85rem; color:#2563eb; background:#f8fafc; box-sizing:border-box;">
                </div>
            </div>

            <!-- Tab 3: Private Link -->
            <div id="tab-private" class="tab-panel" style="display:none;">
                <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:0.75rem; font-weight:700; color:#64748b; text-transform:uppercase; margin-bottom:6px;">Recipient Email</label>
                    <input type="email" placeholder="john@gmail.com" style="width:100%; padding:8px 12px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.875rem; color:#1e293b; box-sizing:border-box;">
                </div>
            </div>

            <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:20px;">
                <button onclick="closeCustomShareModal()" style="padding:8px 16px; border:1px solid #cbd5e1; background:#fff; color:#475569; border-radius:6px; font-weight:500; font-size:0.875rem; cursor:pointer;">Cancel</button>
                <button onclick="closeCustomShareModal()" style="padding:8px 16px; border:none; background:#2563eb; color:#fff; border-radius:6px; font-weight:600; font-size:0.875rem; cursor:pointer;">Save</button>
            </div>
        </div>
    </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);
}

function switchTab(type, btn) {
    document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
    document.querySelectorAll('.tab-btn').forEach(b => {
        b.style.background = 'transparent';
        b.style.color = '#64748b';
        b.style.fontWeight = '500';
    });
    document.getElementById('tab-' + type).style.display = 'block';
    btn.style.background = '#fff';
    btn.style.color = '#2563eb';
    btn.style.fontWeight = '600';
}

function closeCustomShareModal() {
    const modal = document.getElementById('customShareModal');
    if (modal) modal.remove();
}
