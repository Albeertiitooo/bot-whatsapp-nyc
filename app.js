/**
 * ⚡⚡⚡ DECLARAMOS LAS LIBRERIAS y CONSTANTES A USAR! ⚡⚡⚡
 */
require('dotenv').config()
const fs = require('fs');
const express = require('express');
const cors = require('cors')
const qrcode = require('qrcode-terminal');
const { Client, LegacySessionAuth } = require('whatsapp-web.js');
const mysqlConnection = require('./config/mysql')
const { middlewareClient } = require('./middleware/client')
const { generateImage, cleanNumber } = require('./controllers/handle')
const { connectionReady, connectionLost } = require('./controllers/connection')
const { saveMedia } = require('./controllers/save')
const { getMessages, responseMessages, bothResponse } = require('./controllers/flows')
const { sendMedia, sendMessage, lastTrigger, sendMessageButton, readChat, sendMediaVoiceNote } = require('./controllers/send')
const app = express();
app.use(cors())
app.use(express.json())

const server = require('http').Server(app)
const io = require('socket.io')(server, {
    cors: {
        origins: ['http://localhost:4200']
    }
})

let socketEvents = {sendQR:() => {} ,sendStatus:() => {}};

io.on('connection', (socket) => {
    const CHANNEL = 'main-channel';
    socket.join(CHANNEL);
    socketEvents = require('./controllers/socket')(socket)
    console.log('Se conecto')
})

app.use('/', require('./routes/web'))

const port = process.env.PORT || 3000
const SESSION_FILE_PATH = './session.json';
var client;
var sessionData;

/**
 * Escuchamos cuando entre un mensaje
 */
const listenMessage = () => client.on('message', async msg => {
    const { from, body, hasMedia } = msg;
    if (from === 'status@broadcast') {
        return
    }
    message = body.toLowerCase();
    console.log('Message: ',message)
    const number = cleanNumber(from)
    await readChat(number, message)


    /**
     * Guardamos el archivo multimedia que envia
     */
    if (process.env.SAVE_MEDIA && hasMedia) {
        const media = await msg.downloadMedia();
        saveMedia(media);
    }

    /**
     * Si estas usando dialogflow solo manejamos una funcion todo es IA
     */

    if (process.env.DATABASE === 'dialogflow') {
        const response = await bothResponse(message);
        await sendMessage(client, from, response.replyMessage);
        if (response.media) {
            sendMedia(client, from, response.media);
        }
        return
    }

    var step = await getMessages(message);
    console.log({ step })

    
/**
     * Almacenamos la informacion de el PRODUCTO elegido.
     */


 var lastStep = '';
 let productSelection = '';
 let quantitySelection = '';
 

if (step === 'STEP_2_1' || step === 'STEP_2_2' || step === 'STEP_2_3'){

    productSelection = message;

    var lastStep = 'STEP_2'

    console.log('LastStep: ', lastStep);
    console.log('Elegiste:', productSelection)



    var lastStep = 'STEP_2'
}

/**
     * Almacenamos la informacion de la CANTIDAD elegida.
     */

if (step === 'STEP_3'){

    quantitySelection = message;

    console.log('LastStep: ', lastStep);
    console.log('Elegiste: ',quantitySelection, 'de', productSelection )

    lastStep = 'STEP_3'
}

    /**
     * Respondemos al primero paso si encuentra palabras clave
     */


    if (step) {
        const response = await responseMessages(step);

        /**
         * Si quieres enviar botones
         */

        await sendMessage(client, from, response.replyMessage, response.trigger);
        if(response.hasOwnProperty('actions')){
            const { actions } = response;
            await sendMessageButton(client, from, null, actions);
            return
        }

        if (!response.delay && response.media) {
            sendMedia(client, from, response.media);
        }
        if (response.delay && response.media) {
            setTimeout(() => {
                sendMedia(client, from, response.media);
            }, response.delay)
        }
        return
    }

    //Si quieres tener un mensaje por defecto
    if (process.env.DEFAULT_MESSAGE === 'true') {
        const response = await responseMessages('DEFAULT')
        await sendMessage(client, from, response.replyMessage, response.trigger);

        /**
         * Si quieres enviar botones
         */
        if(response.hasOwnProperty('actions')){
            const { actions } = response;
            await sendMessageButton(client, from, null, actions);
        }
        return
    }
});

/**
 * Revisamos si tenemos credenciales guardadas para inciar sessio
 * este paso evita volver a escanear el QRCODE
 */
const withSession = () => {
    // Si exsite cargamos el archivo con las credenciales
    console.log(`Validando session con Whatsapp...`)
    sessionData = require(SESSION_FILE_PATH);
    client = new Client({
        authStrategy: new LegacySessionAuth({
            session: sessionData // saved session object
        }),
        restartOnAuthFail: true,
        puppeteer: {
            args: [
                '--no-sandbox'
            ],
        }
    });

    client.on('ready', () => {
        connectionReady()
        listenMessage()
        loadRoutes(client);
        socketEvents.sendStatus()
    });

    client.on('auth_failure', () => connectionLost())

    client.initialize();
}

/**
 * Generamos un QRCODE para iniciar sesion
 */
const withOutSession = () => {
    console.log('No tenemos session guardada');
    console.log([
        '🙌 El core de whatsapp se esta actualizando',
        '🙌 para proximamente dar paso al multi-device',
    ].join('\n'));

    client = new Client({
        session: { },
        // authStrategy: new LegacySessionAuth({
        //     session: { }
        // }),
        restartOnAuthFail: true,
        puppeteer: {
            args: [
                '--no-sandbox'
            ],
        }
    });

    client.on('qr', qr => generateImage(qr, () => {
        qrcode.generate(qr, { small: true });
        console.log(`Ver QR http://localhost:${port}/qr`)
        socketEvents.sendQR(qr)
    }))

    client.on('ready', (a) => {
        connectionReady()
        listenMessage()
        loadRoutes(client);
        // socketEvents.sendStatus(client)
    });

    client.on('auth_failure', (e) => {
        // console.log(e)
        // connectionLost()
    });

    client.on('authenticated', (session) => {
        sessionData = session;
        fs.writeFile(SESSION_FILE_PATH, JSON.stringify(session), function (err) {
            if (err) {
                console.log(`Ocurrio un error con el archivo: `, err);
            }
        });
    });

    client.initialize();
}

/**
 * Cargamos rutas de express
 */

const loadRoutes = (client) => {
    app.use('/api/', middlewareClient(client), require('./routes/api'))
}
/**
 * Revisamos si existe archivo con credenciales!
 */
(fs.existsSync(SESSION_FILE_PATH)) ? withSession() : withOutSession();

/**
 * Verificamos si tienes un gesto de db
 */

if (process.env.DATABASE === 'mysql') {
    mysqlConnection.connect()
}

server.listen(port, () => {
    console.log(`El server esta listo por el puerto ${port}`);
})


