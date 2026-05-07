require('dotenv').config();

const axios = require('axios');
const tmi = require('tmi.js');
const fs = require('fs');
const express = require('express');

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

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

    const data = JSON.parse(
        fs.readFileSync(clipsFile)
    );

    return data.totalClips || 0;
}

function saveClipCount(count) {

    fs.writeFileSync(
        clipsFile,
        JSON.stringify(
            { totalClips: count },
            null,
            2
        )
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

    } catch {

        console.log(
            'Retrying clip creation...'
        );

        await wait(3000);

        return await createClip(broadcasterId);
    }
}

async function sendClipWebhook(
    username,
    clipUrl,
    totalClips
) {

    try {

        await axios.post(
            process.env.DISCORD_CLIP_WEBHOOK,
            {
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
            }
        );

    } catch {

        console.log(
            'Failed to send clip webhook.'
        );
    }
}

async function sendModWebhook(
    title,
    description,
    color
) {

    try {

        await axios.post(
            process.env.DISCORD_MOD_WEBHOOK,
            {
                embeds: [
                    {
                        title,
                        description,
                        color
                    }
                ]
            }
        );

    } catch {

        console.log(
            'Failed to send mod webhook.'
        );
    }
}

async function getAppAccessToken() {

    const response = await axios.post(
        'https://id.twitch.tv/oauth2/token',
        null,
        {
            params: {
                client_id: process.env.TWITCH_CLIENT_ID,
                client_secret: process.env.TWITCH_CLIENT_SECRET,
                grant_type: 'client_credentials'
            }
        }
    );

    return response.data.access_token;
}

async function createEventSubSubscriptions() {

    try {

        const appToken =
            await getAppAccessToken();

        const headers = {
            'Client-Id':
                process.env.TWITCH_CLIENT_ID,
            'Authorization':
                `Bearer ${appToken}`,
            'Content-Type':
                'application/json'
        };

        const broadcasterId =
            '933882786';

        const subscriptions = [
            {
                type: 'channel.ban',
                version: '1'
            },
            {
                type: 'channel.unban',
                version: '1'
            },
            {
                type: 'channel.moderate',
                version: '2'
            }
        ];

        for (const sub of subscriptions) {

            try {

                await axios.post(
                    'https://api.twitch.tv/helix/eventsub/subscriptions',
                    {
                        type: sub.type,
                        version: sub.version,
                        condition: {
                            broadcaster_user_id:
                                broadcasterId,
                            moderator_user_id:
                                broadcasterId
                        },
                        transport: {
                            method: 'webhook',
                            callback:
                                `${process.env.PUBLIC_URL}/eventsub`,
                            secret:
                                'statsbotsecret'
                        }
                    },
                    { headers }
                );

                console.log(
                    `Subscribed to ${sub.type}`
                );

            } catch (err) {

                console.log(
                    err.response?.data ||
                    err.message
                );
            }
        }

    } catch (err) {

        console.log(
            err.response?.data ||
            err.message
        );
    }
}

client.on(
    'message',
    async (
        channel,
        tags,
        message,
        self
    ) => {

        if (self) return;

        if (
            message.toLowerCase() !==
            '!clip'
        ) return;

        if (cooldown) {

            client.say(
                channel,
                '⏳ Clip command cooldown active.'
            );

            return;
        }

        cooldown = true;

        setTimeout(() => {

            cooldown = false;

        }, 10000);

        try {

            const broadcasterId =
                await getBroadcasterID();

            const clipData =
                await createClipWithRetry(
                    broadcasterId
                );

            if (
                !clipData ||
                !clipData.id
            ) {

                client.say(
                    channel,
                    '⚠️ Failed to create clip.'
                );

                return;
            }

            const clipUrl =
                `https://clips.twitch.tv/${clipData.id}`;

            let totalClips =
                getClipCount();

            totalClips++;

            saveClipCount(totalClips);

            await sendClipWebhook(
                tags.username,
                clipUrl,
                totalClips
            );

            client.say(
                channel,
                `🎬 Clip created by ${tags.username}! ${clipUrl} | 📊 StatsBot has created ${totalClips} clips`
            );

        } catch (err) {

            console.log(
                err.response?.data ||
                err.message
            );

            client.say(
                channel,
                '⚠️ Clip creation failed.'
            );
        }
    }
);

app.post(
    '/eventsub',
    async (req, res) => {

        const messageType =
            req.header(
                'Twitch-Eventsub-Message-Type'
            );

        if (
            messageType ===
            'webhook_callback_verification'
        ) {

            return res
                .status(200)
                .send(req.body.challenge);
        }

        const event = req.body.event;

        const subscriptionType =
            req.body.subscription?.type;

        if (!event) {

            return res.sendStatus(200);
        }

        const moderator =
            event
                .moderator_user_login
                ?.toLowerCase();

        if (
            moderator ===
            'sery_bot'
        ) {

            return res.sendStatus(200);
        }

        try {

            if (
                subscriptionType ===
                'channel.ban'
            ) {

                await sendModWebhook(
                    '🔨 User Banned',
                    `👤 User: ${event.user_name}\n\n🛡️ Moderator: ${event.moderator_user_name}\n\n📝 Reason: ${event.reason || 'No reason provided'}`,
                    16711680
                );
            }

            if (
                subscriptionType ===
                'channel.unban'
            ) {

                await sendModWebhook(
                    '✅ User Unbanned',
                    `👤 User: ${event.user_name}\n\n🛡️ Moderator: ${event.moderator_user_name}`,
                    65280
                );
            }

            if (
                subscriptionType ===
                'channel.moderate'
            ) {

                const action =
                    event.action;

                if (
                    action ===
                    'timeout'
                ) {

                    await sendModWebhook(
                        '⏰ User Timed Out',
                        `👤 User: ${event.user_name}\n\n🛡️ Moderator: ${event.moderator_user_name}`,
                        16753920
                    );
                }

                if (
                    action ===
                    'untimeout'
                ) {

                    await sendModWebhook(
                        '✅ Timeout Removed',
                        `👤 User: ${event.user_name}\n\n🛡️ Moderator: ${event.moderator_user_name}`,
                        65280
                    );
                }

                if (
                    action ===
                    'delete'
                ) {

                    await sendModWebhook(
                        '🗑️ Message Deleted',
                        `👤 User: ${event.user_name}\n\n🛡️ Moderator: ${event.moderator_user_name}\n\n💬 Message Deleted`,
                        10038562
                    );
                }

                if (
                    action ===
                    'vip'
                ) {

                    await sendModWebhook(
                        '⭐ VIP Added',
                        `👤 User: ${event.user_name}\n\n🛡️ Moderator: ${event.moderator_user_name}`,
                        16766720
                    );
                }

                if (
                    action ===
                    'unvip'
                ) {

                    await sendModWebhook(
                        '❌ VIP Removed',
                        `👤 User: ${event.user_name}\n\n🛡️ Moderator: ${event.moderator_user_name}`,
                        16711680
                    );
                }
            }

        } catch (err) {

            console.log(
                err.response?.data ||
                err.message
            );
        }

        res.sendStatus(200);
    }
);

app.listen(PORT, () => {

    console.log(
        `EventSub server running on port ${PORT}`
    );
});

createEventSubSubscriptions();