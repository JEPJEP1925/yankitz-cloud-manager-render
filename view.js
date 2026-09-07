function escapeHtml(str) {
    if (str === undefined || str === null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeForInlineHandler(str) {
    if (str === undefined || str === null) return '';
    const jsEscaped = String(str)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'");
    return escapeHtml(jsEscaped);
}

document.addEventListener('DOMContentLoaded', () => {
    loadActiveShares();

    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadActiveShares);
    }
});

async function loadActiveShares() {
    const tableBody = document.getElementById('sharesTableBody');
    if (!tableBody) return;

    try {
        const response = await fetch('/api/shares');
        if (!response.ok) {
            throw new Error(`Server returned ${response.status}`);
        }
        
        const shares = await response.json();

        if (!Array.isArray(shares) || shares.length === 0) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="6" class="text-center text-muted py-4">No active shared links available. Upload a file above to get started.</td>
                </tr>`;
            return;
        }

        tableBody.innerHTML = shares.map(share => {
            const safeSlug = escapeHtml(share.slug || share.id);
            const safeFilename = escapeHtml(share.filename || 'Untitled');
            const safeType = escapeHtml(share.file_type || 'file');
            const safeDownloads = escapeHtml(share.downloads || 0);
            const safeMaxDownloads = escapeHtml(share.max_downloads || '∞');
            const safeUrl = escapeHtml(share.url || '');
            const handlerId = escapeForInlineHandler(share.id);

            return `
            <tr>
                <td><code>${safeSlug}</code></td>
                <td>${safeFilename}</td>
                <td><span class="badge bg-secondary text-uppercase">${safeType}</span></td>
                <td>${safeDownloads} / ${safeMaxDownloads}</td>
                <td><a href="${safeUrl}" target="_blank" class="text-primary text-decoration-none">${safeUrl}</a></td>
                <td>
                    <button onclick="deleteShare('${handlerId}')" class="btn btn-sm btn-outline-danger">Delete</button>
                </td>
            </tr>
        `;
        }).join('');

    } catch (error) {
        console.error('Error fetching shares:', error);
        tableBody.innerHTML = `
            <tr>
                <td colspan="6" class="text-center text-danger py-3">Error loading links. Please check server logs or refresh.</td>
            </tr>`;
    }
}

async function deleteShare(id) {
    if (!confirm('Are you sure you want to delete this shared link?')) return;
    try {
        const res = await fetch(`/api/shares/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            loadActiveShares();
        } else {
            alert('Failed to delete share link.');
        }
    } catch (e) {
        alert('Network error while attempting to delete.');
    }
}
