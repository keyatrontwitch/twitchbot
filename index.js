require('dotenv').config();

const axios = require('axios');
const tmi = require('tmi.js');
const fs = require('fs');

async function testToken() {

    try {

        const response = await axios.get(
            'https://id.twitch.tv/oauth2/validate',
            {
                headers: {
                    Authorization: `OAuth ${process.env.TWITCH_TOKEN.replace('oauth:', '')}`
                }
            }
        );

        console.log('TOKEN INFO:');
        console.log(response.data);

    } catch (err) {

        console.log('TOKEN ERROR:');
        console.log(err.response?.data || err.message);

    }
}

testToken();

console.log('CLIENT ID:', process.env.TWITCH_CLIENT_ID);
console.log('USERNAME:', process.env.TWITCH_USERNAME);
console.log('CHANNEL:', process.env.TWITCH_CHANNEL);

const client = new tmi.Client({
    options: {
        debug: true
    },
    identity: {
        username: process.env.TWITCH_USERNAME,
        password: process.env.TWITCH_TOKEN
    },
    channels: [process.env.TWITCH_CHANNEL]
});

client.connect();

const clipsFile = './clips.json';

let cooldown = false;

function wait(ms) {

    return new Promise(resolve => setTimeout(resolve, ms));
}

function getClipCount() {

    if (!fs.existsSync(clipsFile)) {

        fs.writeFileSync(
            clipsFile,
            JSON.stringify({ totalClips: 0 }, null, 2)
        );
    }

    const data = JSON.parse(fs.readFileSync(clipsFile));

    return data.totalClips || 0;
}

function saveClipCount(count) {

    fs.writeFileSync(
        clipsFile,
        JSON.stringify({ totalClips: count }, null, 2)
    );
}

async function getBroadcasterID() {

    const response = await axios.get(
        `https://api.twitch.tv/helix/users?login=${process.env.TWITCH_CHANNEL}`,
        {
            headers: {
                'Client-ID': process.env.TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${process.env.TWITCH_TOKEN.replace('oauth:', '')}`
            }
        }
    );

    return response.data.data[0].id;
}

async function createClip(broadcasterId) {

    const response = await axios.post(
        `https://api.twitch.tv/helix/clips?broadcaster_id=${broadcasterId}`,
        {},
        {
            headers: {
                'Client-ID': process.env.TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${process.env.TWITCH_TOKEN.replace('oauth:', '')}`
            }
        }
    );

    return response.data.data[0];
}

async function createClipWithRetry(broadcasterId) {

    try {

        return await createClip(broadcasterId);

    } catch (err) {

        console.log('First clip attempt failed. Retrying in 3 seconds...');

        await wait(3000);

        return await createClip(broadcasterId);
    }
}

async function updateClipTitle(clipId, username) {

    try {

        await axios.patch(
            `https://api.twitch.tv/helix/clips?id=${clipId}`,
            {
                title: `StatsBot clipped this by: ${username}`
            },
            {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${process.env.TWITCH_TOKEN.replace('oauth:', '')}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('Clip title updated.');

    } catch (err) {

        console.log('Failed to update clip title.');

    }
}

async function sendDiscordWebhook(username, clipUrl, totalClips) {

    try {

        await axios.post(process.env.DISCORD_WEBHOOK, {
            embeds: [
                {
                    title: '🎬 New Clip Created',
                    description:
                        `👤 Clipped By: ${username}\n\n` +
                        `🔗 ${clipUrl}\n\n` +
                        `📊 Total Clips: ${totalClips}`,
                    color: 6570404
                }
            ]
        });

        console.log('Discord webhook sent.');

    } catch (err) {

        console.log('Failed to send Discord webhook.');

    }
}

client.on('message', async (channel, tags, message, self) => {

    if (self) return;

    if (message.toLowerCase() !== '!clip') return;

    if (cooldown) {

        client.say(
            channel,
            '⏳ Clip command is on cooldown.'
        );

        return;
    }

    cooldown = true;

    setTimeout(() => {

        cooldown = false;

    }, 10000);

    try {

        const broadcasterId = await getBroadcasterID();

        const clipData = await createClipWithRetry(broadcasterId);

        if (!clipData || !clipData.id) {

            client.say(
                channel,
                '⚠️ Failed to create clip.'
            );

            return;
        }

        await wait(5000);

        await updateClipTitle(
            clipData.id,
            tags.username
        );

        const clipUrl = `https://clips.twitch.tv/${clipData.id}`;

        let totalClips = getClipCount();

        totalClips++;

        saveClipCount(totalClips);

        await sendDiscordWebhook(
            tags.username,
            clipUrl,
            totalClips
        );

        client.say(
            channel,
            `🎬 Clip created by ${tags.username}! ${clipUrl} | 📊 StatsBot has created ${totalClips} clips`
        );

        console.log(`Clip created successfully: ${clipUrl}`);

    } catch (err) {

        console.log('FULL ERROR:');

        console.log(err.response?.data || err.message);

        client.say(
            channel,
            '⚠️ Clip creation failed. Please try again in a few seconds.'
        );
    }
});