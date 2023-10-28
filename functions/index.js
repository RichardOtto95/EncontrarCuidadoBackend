const functions = require("firebase-functions");
const firebase = require("firebase-admin");
firebase.initializeApp({ credential: firebase.credential.applicationDefault() });
const messaging = firebase.messaging();
var firestore = firebase.firestore();
firestore.settings({ timestampsInSnapshots: true });
var moment = require('moment-timezone');
const Stripe = require('stripe');
// const secretKey = functions.config().stripe.key;
// const stripe = Stripe(secretKey);
const stripe = Stripe('sk_test_51JfUnoKyma1BOzHChPWCi6rBrAGCgNWjqqpDy7ilbOWinPsOHqnUswLTvfv2GNjtRYQ6vFh5Rd7bkMrAzlJDhBLq00QVb01XEo');
const map = require("lodash");
var TIMEZONE_NAME = 'America/Sao_Paulo';
moment.locale('pt-br');
moment.tz.setDefault(TIMEZONE_NAME);

// -----------------------------------------Funções do Stripe---------------------------------------- //

// Função que retornará a data da próxima fatura da assinatura.
exports.futureInvoice = functions.https.onCall(async (data, context) => {
    const subscription = await stripe.subscriptions.retrieve(
        data.subscriptionId,
    );

    console.log("xxxxxxxx subscription current_period_end: ", subscription.current_period_end);
    const currentPeriodEnd = subscription.current_period_end;

    console.log("xxxxxxxx currentPeriodEnd 1: ", moment(currentPeriodEnd * 1000).format("DD/MM/YYYY HH:mm"));
    return moment(currentPeriodEnd * 1000).format("DD/MM/YYYY HH:mm");
});

// Rotina para alterar o premium para falso caso a assinatura no stripe tenha o status diferente de ativo
exports.removePremium = functions.pubsub.schedule('every 2 minutes').onRun(async (context) => {
    const infoQuery = await firebase.firestore().collection("info").get();
    const infoDoc = infoQuery.docs[0];
    let premiumDoctors = await firestore.collection("doctors").where("premium", "==", true).get();

    console.log("Premium doctors size: " + premiumDoctors.size);

    premiumDoctors.forEach(async (doctor) => {
        console.log("xxxxxxxxxxxxxx subscriptionStatus: " + doctor.get("subscription_status"));

        if (doctor.get("subscription_status")) {
            switch (doctor.get("subscription_status")) {
                case "FREE_DAYS":
                    console.log("switch 1");

                    var differenceDays = await differenceInDays(doctor.get("subscription_created_at"));

                    if (differenceDays > infoDoc.get("free_days")) {
                        const hasError = await hiringThePlan(doctor.id);
                        if (hasError == null) {
                            await changePremium(doctor.id, true);
                        } else {
                            doctor.ref.update({ subscription_status: "CANCELED" });
                            await changePremium(doctor.id, false);
                        }
                    }
                    break;

                case "FREE_DAYS_CANCELED":
                    console.log("switch 2");

                    var differenceDays = await differenceInDays(doctor.get("subscription_created_at"));

                    if (differenceDays > infoDoc.get("free_days")) {
                        doctor.ref.update({ subscription_status: "CANCELED" });
                    }
                    break;

                case "PENDING_CANCELLATION":
                    await cancelingThePlan(doctor.id);
                    break;

                case "HIRED":
                    await lastPayment(doctor.id);
                    await cancelingThePlan(doctor.id);
                    break;

                default:
                    console.log("xxxxxxxxxx default");
                    break;
            }
        }
    });
});

// Método que cancela uma assinatura
exports.removeSignature = functions.https.onCall(async (data, context) => {
    console.log("xxxxxxxxxxxx removeSignature: ", data.userId);

    const userDoc = await firebase.firestore().collection("doctors").doc(data.userId).get();


    console.log("xxxxxxxxxxxx userDoc.get(subscription_status): ", userDoc.get("subscription_status"));

    if (userDoc.get("subscription_status") == "FREE_DAYS") {
        await userDoc.ref.update({
            "subscription_status": "FREE_DAYS_CANCELED",
        });

    } else {
        const updated = await stripe.subscriptions.update(
            userDoc.get("subscription_id"),
            { cancel_at_period_end: true }
        );

        console.log("xxxxxx removeSignature updated: ", updated);

        await userDoc.ref.update({
            "subscription_status": "PENDING_CANCELLATION",
        });
    }

    const now = firebase.firestore.FieldValue.serverTimestamp();

    let notification = {
        created_at: now,
        dispatched_at: now,
        id: null,
        sender_id: null,
        receiver_id: userDoc.id,
        status: "SCHEDULED",
        text: "Sua assinatura foi cancelada",
        type: "AUTO",
        viewed: false,
    };

    let receiver = firestore.collection("doctors").doc(userDoc.id);

    let notUserRef = await receiver.collection("notifications").add(notification);
    await notUserRef.update({ id: notUserRef.id });

    let notRef = firestore.collection("notifications").doc(notUserRef.id);
    await notRef.set(notification);
    await notRef.update({ id: notUserRef.id });

    await onSendMessage(notUserRef.id, userDoc.id, "doctors");
});

// Método de criação da assinatura.
exports.signing = functions.https.onCall(async (data, context) => {
    const userDoc = await firebase.firestore().collection("doctors").doc(data.userId).get();

    try {
        console.log("xxxxxxxxxxxxx subscription status: ", userDoc.get("subscription_status"));

        switch (userDoc.get("subscription_status")) {
            case null:
                console.log("xxxxxxxxxxx switch case 1");
                await userDoc.ref.update({
                    "subscription_created_at": firebase.firestore.FieldValue.serverTimestamp(),
                    "subscription_status": "FREE_DAYS",
                });

                await changePremium(userDoc.id, true);
                break;

            case "PENDING_CANCELLATION":
                console.log("xxxxxxxxxxx switch case 2");
                await userDoc.ref.update({
                    "subscription_status": "HIRED",
                });

                const updated = await stripe.subscriptions.update(
                    userDoc.get("subscription_id"),
                    { cancel_at_period_end: false }
                );

                console.log("xxxxxx switch pending_canceled updated: ", updated);
                break;

            case "FREE_DAYS_CANCELED":
                console.log("xxxxxxxxxxx switch case 3");

                await userDoc.ref.update({
                    "subscription_status": "FREE_DAYS",
                });
                break;

            case "CANCELED":
                console.log("xxxxxxxxxxx switch case 4");

                const hasError = await hiringThePlan(userDoc.id);

                if (hasError == null) {
                    await userDoc.ref.update({
                        "subscription_status": "HIRED",
                    });

                    await changePremium(userDoc.id, true);
                } else {
                    return hasError;
                }
                break;

            default:
                console.log("xxxxxxxxxxx switch default");

                return "type not found";
        }

        const now = firebase.firestore.FieldValue.serverTimestamp();

        let notification = {
            created_at: now,
            dispatched_at: now,
            id: null,
            sender_id: null,
            receiver_id: userDoc.id,
            status: "SCHEDULED",
            text: "Plano EncontrarCuidado contratado!",
            type: "AUTO",
            viewed: false,
        };

        let notUserRef = await userDoc.ref.collection('notifications').add(notification);
        await notUserRef.update({ id: notUserRef.id });
        let notRef = firestore.collection('notifications').doc(notUserRef.id);
        await notRef.set(notification);
        await notRef.update({ id: notUserRef.id });


        await onSendMessage(notUserRef.id, userDoc.id, "doctors");

        return null;
    } catch (error) {
        console.log("xxxxxxxxxxxxxx error: ", error.code);
        return error.code;
    }
});

async function differenceInDays(createdAtSubscription) {
    var createdAtMoment = moment(createdAtSubscription._seconds * 1000).format();
    var nowMoment = moment(firebase.firestore.Timestamp.now()._seconds * 1000).format();

    console.log('############# timesTampNow ' + firebase.firestore.Timestamp.now());

    console.log('############# timesTampNow ' + moment(firebase.firestore.Timestamp.now()._seconds * 1000).format("YYYY-MM-DD HH:mm:ss"));

    console.log('############# createdAtMoment ' + createdAtMoment);

    console.log('############# createdAtMoment ' + moment(createdAtSubscription._seconds * 1000).format("YYYY-MM-DD HH:mm:ss"));

    var differenceDays = moment(nowMoment).diff(createdAtMoment, "days");

    console.log('############# differenceDays ' + differenceDays);
    return differenceDays;
}

exports.lastPaymentTeste = functions.https.onCall(async (data, context) => {
    lastPayment(data.id);
});

async function lastPayment(doctorId){
    const doctor = await firebase.firestore().collection("doctors").doc(doctorId).get();

    const customerId = await doctor.get("customer_id");
    const subscriptionId = await doctor.get("subscription_id");

    const invoiceItems = await stripe.invoices.list({
        customer: customerId,
        status: 'paid',
    });

    console.log("last payment invoiceItems: ", invoiceItems);
    console.log("last payment invoiceItems: ", invoiceItems.data.length);

    for (let index = 0; index < invoiceItems.data.length; index++) {
        const invoice = invoiceItems.data[index];        

        console.log("element: ", invoice.id);
        
        const transactionsQuery = await doctor.ref.collection("transactions").where("type", "==", "SUBSCRIPTION").where("invoice_id", "==", invoice.id).get();

        console.log("transactionsQuery: ", transactionsQuery.docs.length);

        if(transactionsQuery.docs.length == 0){
            const infoQuery = await firebase.firestore().collection("info").get();
            const infoDoc = infoQuery.docs[0];

            const transactionRef =
                await doctor.ref.collection("transactions").add({
                    "created_at": firebase.firestore.FieldValue.serverTimestamp(),
                    "updated_at": firebase.firestore.FieldValue.serverTimestamp(),
                    "appointment_id": null,
                    "type": "SUBSCRIPTION",
                    "receiver": "EncontrarCuidado",
                    "receiver_id": null,
                    "sender": doctor.get("username"),
                    "sender_id": doctorId,
                    "status": "OUTCOME",
                    "note": "subscription payment",
                    "value": infoDoc.get("current_monthly_price"),
                    "id": null,
                    "subscription_id": subscriptionId,
                    "payment_intent": null,
                    "invoice_id": invoice.id,
                });

            await transactionRef.update({ "id": transactionRef.id });

            await firestore.collection("transactions").doc(transactionRef.id).set({
                "created_at": firebase.firestore.FieldValue.serverTimestamp(),
                "updated_at": firebase.firestore.FieldValue.serverTimestamp(),
                "appointment_id": null,
                "type": "SUBSCRIPTION",
                "receiver": doctor.get("username"),
                "receiver_id": doctorId,
                "sender": "encontrarCuidado",
                "sender_id": null,
                "status": "OUTCOME",
                "note": "subscription payment",
                "value": infoDoc.get("current_monthly_price"),
                "id": transactionRef.id,
                "subscription_id": subscriptionId,
                "payment_intent": null,
                "invoice_id": invoice.id,
            });
        }
    }
}

async function cancelingThePlan(doctorId) {
    const doctor = await firebase.firestore().collection("doctors").doc(doctorId).get();

    const subscription = await stripe.subscriptions.retrieve(doctor.get("subscription_id"));

    console.log("DoctorId: " + doctor.id + "subscription status: " + subscription["status"]);

    if (subscription["status"] != "active") {
        const removed = await stripe.subscriptions.del(
            doctor.get("subscription_id"),
        );

        console.log("remove signature, removed: ", removed);

        // const doctorTransactionSubscriptionQuery = await doctor.ref.collection("transactions").where("subscription_id", "==", doctor.get("subscription_id")).get();

        // const doctorTransactionSubscriptionDoc = doctorTransactionSubscriptionQuery.docs[0];

        // await doctorTransactionSubscriptionDoc.ref.update({ "status": "CANCELED" });

        // await firebase.firestore().collection("transactions").doc(doctorTransactionSubscriptionDoc.id).update({ "status": "CANCELED" });

        await doctor.ref.update({ subscription_status: "CANCELED", subscription_id: null });
        await changePremium(doctor.id, false);
    }
}

async function hiringThePlan(doctorId) {
    const userDoc = await firebase.firestore().collection("doctors").doc(doctorId).get();
    const infoQuery = await firebase.firestore().collection("info").get();
    const infoDoc = infoQuery.docs[0];

    param = {
        customer: userDoc.get("customer_id"),
        items: [
            { price: infoDoc.get("price_id") },
        ],
    };

    try {
        const subscription = await stripe.subscriptions.create(param);

        console.log("sssssss subscription id: ", subscription.id);
        console.log("sssssss subscription status: ", subscription.status);

        if (subscription.status == "incomplete") {
            const subscriptionDeleted = await stripe.subscriptions.del(
                subscription.id,
            );

            return "insufficient funds";
        } else {
            await userDoc.ref.update({
                "subscription_id": subscription.id,
                "subscription_status": "HIRED",
            });

            lastPayment(userDoc.id);            
            return null;
        }
    } catch (error) {
        console.log("error: ");

        console.log(error);
        return error.code;
    }
}

// função para alterar o campo premium do doutor e de seus respectivos secretários.
async function changePremium(doctorId, value) {
    const doctor = await firebase.firestore().collection("doctors").doc(doctorId).get();
    await doctor.ref.update({ premium: value });

    const secretaries = await doctor.ref.collection("secretaries").where("status", "==", "ACCEPTED").get();

    secretaries.docs.forEach(async (secretary) => {
        const secretaryDoc = await firebase.firestore().collection("doctors").doc(secretary.id).get();
        await secretaryDoc.ref.update({ doctor_is_premium: value });
    });
}

//  função que rodará todo dia, realizando os estornos solicitados.
// exports.refundTimer = functions.pubsub.schedule('every day').onRun(async (context) => {  
exports.refundTimer = functions.pubsub.schedule('every 2 minutes').onRun(async (context) => {
    const transactionsQuery = await firebase.firestore().collection("transactions").where("status", "==", "PENDING_REFUND").get();

    transactionsQuery.docs.forEach(async (transactionDoc) => {
        var newType;
        if (transactionDoc.get("type") == "GUARANTEE") {
            newType = "GUARANTEE_REFUND";
        } else {
            newType = "REMAINING_REFUND";
        }

        await transactionDoc.ref.update({
            "status": "REFUND",
            "type": newType,
            "updated_at": firebase.firestore.FieldValue.serverTimestamp(),
        });

        await firebase.firestore().collection(`patients/${transactionDoc.get("sender_id")}/transactions`)
            .doc(transactionDoc.id)
            .update({
                "status": "REFUND",
                "type": newType,
                "updated_at": firebase.firestore.FieldValue.serverTimestamp(),
            });

        await firebase.firestore().collection(`doctors/${transactionDoc.get("receiver_id")}/transactions`)
            .doc(transactionDoc.id)
            .update({
                "status": "REFUND",
                "type": newType,
                "updated_at": firebase.firestore.FieldValue.serverTimestamp(),
            });

        const refund = await stripe.refunds.create(
            {
                payment_intent: transactionDoc.get("payment_intent"),
            },

            async function (err, refundObj) {
                if (err) {
                    console.log("erro ao reembolsar: ", err);
                }

                if (refundObj) {
                    console.log("sucesso ao reembolsar: ", refundObj);
                }

            });
    });
});

// Função que cobra o caução da consulta.
exports.securityDeposit = functions.https.onCall(async (data, context) => {
    console.log("xxxxxxxxxxxx securityDeposit", data.patientId, data.price);
    const patientDoc = await firebase.firestore().collection("patients").doc(data.patientId).get();
    const customerId = patientDoc.get("customer_id");
    const price = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2 }).format(data.price).replace(",", "");
    console.log("ccccccccccccc price formatado", price);

    const cardsQuery = await patientDoc.ref.collection("cards").where("main", "==", true).get();
    const cardDoc = cardsQuery.docs[0];
    const cardId = cardDoc.get("card_id");

    const param = {
        payment_method: cardId,
        payment_method_types: ['card'],
        amount: price,
        currency: 'brl',
        customer: customerId,
        confirm: true,
        receipt_email: patientDoc.get("email"),
        // description: "security deosit",
    };

    try {
        const paymentIntent = await stripe.paymentIntents.create(param);

        console.log("xxxxxxxxxxxxx doctor: ", data.doctorId);

        const doctorDoc =
            await firebase.firestore().collection("doctors").doc(data.doctorId).get();

        const now = firebase.firestore.FieldValue.serverTimestamp();

        var newType;
        if (data.remaining) {
            newType = "REMAINING";
        } else {
            newType = "GUARANTEE";
        }

        console.log("xxxxxxxxxxxxx newType: ", newType);

        const transactionRef =
            await firebase.firestore().collection("transactions").add({
                "created_at": now,
                "updated_at": now,
                "appointment_id": data.appointmentId,
                "type": newType,
                "receiver": doctorDoc.get("username"),
                "receiver_id": data.doctorId,
                "sender": patientDoc.get("username"),
                "sender_id": data.patientId,
                "status": "OUTCOME",
                "note": "",
                "value": data.price,
                "id": null,
                "payment_intent": paymentIntent.id,
            });

        console.log("sssssssssss transactionRef.id", transactionRef.id);

        await transactionRef.update({ "id": transactionRef.id });

        const doctorTransactionRef =
            await doctorDoc.ref.collection("transactions").doc(transactionRef.id).set({
                "created_at": now,
                "updated_at": now,
                "appointment_id": data.appointmentId,
                "type": newType,
                "receiver": doctorDoc.get("username"),
                "receiver_id": data.doctorId,
                "sender": patientDoc.get("username"),
                "sender_id": data.patientId,
                "status": "PENDING_INCOME",
                "note": "",
                "value": data.price,
                "id": transactionRef.id,
                "payment_intent": paymentIntent.id,
            });

        const patientTransactionRef =
            await patientDoc.ref.collection("transactions").doc(transactionRef.id).set({
                "created_at": now,
                "updated_at": now,
                "appointment_id": data.appointmentId,
                "type": newType,
                "receiver": doctorDoc.get("username"),
                "receiver_id": data.doctorId,
                "sender": patientDoc.get("username"),
                "sender_id": data.patientId,
                "status": "OUTCOME",
                "note": "",
                "value": data.price,
                "id": transactionRef.id,
                "payment_intent": paymentIntent.id,
            });

        console.log("sssssssssss paymentIntent.id", paymentIntent.id);

        let notDocText = "";
        let notPatText = "";

        let appointmentId = "";
        appointmentId = data.appointmentId;
        console.log("sssssssssss appointmentId", appointmentId);

        let appointmentIdSub = appointmentId.substring(appointmentId.length - 4, appointmentId.length).toUpperCase();

        console.log("sssssssssss appointmentIdSub", appointmentIdSub);

        let appointmentDoc = await firestore.collection("appointments").doc(data.appointmentId).get();

        console.log("sssssssssss appointmentDoc", appointmentDoc.id);

        let patientName = "";

        if (appointmentDoc.get("dependent_id") == null) {
            patientName = patientDoc.get("username");
        } else {
            let dependent = await firestore.collection("patients").doc(appointmentDoc.get("dependent_id")).get();
            patientName = dependent.get("username");
        }

        console.log("sssssssssss patientName", patientName);

        if (data.remaining) {
            notDocText = "Foi cobrado do paciente " + patientName + " o valor remanescente da consulta " + appointmentIdSub;
            notPatText = "Foi cobrado o valor remanescente da consulta " + appointmentIdSub;
        } else {
            notDocText = "O paciente " + patientName + " pagou a caução";
        }

        console.log("sssssssssss remaining", data.remaining);

        let docNotification = {
            created_at: now,
            dispatched_at: now,
            id: null,
            receiver_id: data.doctorId,
            sender_id: data.patientId,
            status: "SCHEDULED",
            text: notDocText,
            type: "AUTO",
            viewed: false,
        };

        let patNotification = {
            created_at: now,
            dispatched_at: now,
            id: null,
            receiver_id: data.patientId,
            sender_id: data.doctorId,
            status: "SCHEDULED",
            text: notPatText,
            type: "AUTO",
            viewed: false,
        };

        let notDocDoc = await firestore.collection("notifications").add(docNotification);
        await notDocDoc.update({ id: notDocDoc.id });

        let notDocDocSub = doctorDoc.ref.collection("notifications").doc(notDocDoc.id);
        await notDocDocSub.set(docNotification);
        await notDocDocSub.update({ id: notDocDoc.id });

        console.log("sssssssssss notDocDoc.id", notDocDoc.id);


        await onSendNotification(notDocDoc.id, data.doctorId, "doctors");

        if (data.remaining) {
            let notPatDoc = await firestore.collection("notifications").add(patNotification);
            await notPatDoc.update({ id: notPatDoc.id });
            let notPatDocSub = patientDoc.ref.collection("notifications").doc(notPatDoc.id);
            await notPatDocSub.set( patNotification );
            await notPatDocSub.update({ id: notPatDoc.id })

            await onSendNotification(notPatDoc.id, data.patientId, "patients");
        }

        return null;

    } catch (error) {
        console.log("xxxxxxx error: ", error.code);
        return error.code;
    }
});

// Função que remove os cartões.
exports.deleteCard = functions.https.onCall(async (data, context) => {
    console.log("xxxxxxxxxxx changingCardToMain: ", data.userId, data.cardId);
    const user = await firebase.firestore().collection(data.userCollection).doc(data.userId).get();
    const customerId = user.get("customer_id");

    console.log("xxxxxxxxxxx customerId: ", customerId);

    const cardDoc = await user.ref.collection("cards").doc(data.cardId).get();
    const cardCustomerId = cardDoc.get("card_id");

    console.log("xxxxxxxxxxx cardCustomerId: ", cardCustomerId);

    const deleted = await stripe.customers.deleteSource(
        customerId,
        cardCustomerId,
    );

    var paymentMethod = await firebase.firestore().collection(`stripe_customers/${data.userId}/payment_method`).where("id", "==", cardCustomerId).get();

    if (paymentMethod.docs.length != 0) {
        var paymentMethodDoc = paymentMethod.docs[0];
        await paymentMethodDoc.ref.update({ "status": "REMOVED" });
    }

    console.log("xxxxxxxxxxx removeCard: ", cardDoc.get("main"));


    if (cardDoc.get("main")) {
        const cardsQuery = await firebase.firestore()
            .collection(data.userCollection)
            .doc(data.userId)
            .collection("cards")
            .where("status", "==", "ACTIVE")
            .orderBy("created_at", "desc")
            .get();

        for (var i = 0; i < cardsQuery.docs.length; i++) {
            const cardRef = cardsQuery.docs[i];

            console.log("xxxxxxxxxxx for: ", cardRef.get("id"));


            if (cardRef.get("id") != data.cardId) {
                await cardRef.ref.update({ "main": true });

                const customer = await stripe.customers.update(
                    customerId,
                    { invoice_settings: { default_payment_method: cardRef.get("card_id") } }
                );
                break;
            }
        }
    }

    await cardDoc.ref.update({ 'status': 'REMOVED', 'main': false });

});

// Função que altera o cartão principal.
exports.changingCardToMain = functions.https.onCall(async (data, context) => {
    console.log("xxxxxxxxxxx changingCardToMain: ", data.userId, data.cardId, data.main, data.userCollection);
    const user = await firebase.firestore().collection(data.userCollection).doc(data.userId).get();
    const customerId = user.get("customer_id");

    console.log("xxxxxxxxxxx customerId: ", customerId);

    const cardsQuery = await user.ref
        .collection("cards")
        .where("status", "==", "ACTIVE")
        .orderBy("created_at", "desc")
        .get();

    if (data.main) {
        const cardDoc = await user.ref.collection("cards").doc(data.cardId).get();
        await cardDoc.ref.update({ "main": true });
        const cardCustomerId = cardDoc.get("card_id");

        console.log("xxxxxxxxxxx cardCustomerId: ", cardCustomerId);

        const customer = await stripe.customers.update(
            customerId,
            { invoice_settings: { default_payment_method: cardCustomerId } }
        );

        cardsQuery.docs.forEach((cardsDoc) => {
            if (data.cardId != cardsDoc.id) {
                cardsDoc.ref.update({ "main": false });
            }
        });
    } else {
        await user.ref.collection("cards").doc(data.cardId).update({ "main": false });

        for (var i = 0; i < cardsQuery.docs.length; i++) {
            var cardsDoc = cardsQuery.docs[i];
            if (cardsDoc.get("id") != data.cardId) {
                const cardDoc = await user.ref.collection("cards").doc(cardsDoc.get("id")).get();
                const cardCustomerId = cardDoc.get("card_id");

                console.log("xxxxxxxxxxx cardCustomerId: ", cardCustomerId);


                const customer = await stripe.customers.update(
                    customerId,
                    { invoice_settings: { default_payment_method: cardCustomerId } }
                );

                cardsDoc.ref.update({ "main": true });
                break;
            }
        }
    }
}
);

// verificando se o usuário já está no banco ou no stripe, caso não esteja já adiciona, caso esteja só cria o método depagamento.
exports.createStripeCustomer = functions.https.onCall(async (data, context) => {
    console.log('###### createStripeCustomer', data.uid, data.email);
    const customerDoc = await firebase.firestore().collection("stripe_customers").doc(data.uid).get();
    const boolHaveDoc = customerDoc.exists;
    var boolHaveCustomer = false;
    console.log('###### boolHaveDoc ', boolHaveDoc);
    if (boolHaveDoc) {
        try {
            const hasCustomer = await stripe.customers.retrieve(customerDoc.get("customer_id"));
            boolHaveCustomer = true;
            // console.log('###### hasCustomer', hasCustomer);      
        } catch (error) {
            console.log('###### error', error);
            return error;
        }
        console.log('###### createStripeCustomer if', boolHaveCustomer);
    }

    if (!boolHaveCustomer) {
        const customer = await stripe.customers.create({ email: data.email });
        console.log('###### createStripeCustomer', customer.id);
        const intent = await stripe.setupIntents.create({
            customer: customer.id,
        });
        if (!boolHaveDoc) {
            await firebase.firestore().collection("stripe_customers").doc(data.uid).set({
                customer_id: customer.id,
                setup_secret: intent.client_secret,
            });

            await firebase.firestore().collection(data.userCollection).doc(data.uid).update({ "customer_id": customer.id });
        }
    }

    var error = await createPaymentMethod(data.card, data.uid, data.userCollection);
    return error;
});

// Método inicial para criar um cartão de um cliente no stripe...
async function createPaymentMethod(card, userUid, userCollection) {
    const user = await firebase.firestore().collection(userCollection).doc(userUid).get();
    const customerId = user.get("customer_id");
    var param = {};
    var codeError = "";

    console.log("xxxxxxxxxxxxxxxxxxxxxxxxxxx card: ", card);

    param.card = {
        number: card.card_number,
        exp_month: card.due_date.substring(0, 2),
        exp_year: '20' + card.due_date.substring(2, 4),
        cvc: card.security_code,
        address_city: card.city,
        address_country: "Brasil",
        address_line1: card.billing_address,
        address_state: card.billing_state,
        name: card.name_card_holder,
    };

    var newCard = {
        billing_address: card.billing_address,
        billing_cep: card.billing_cep,
        billing_district: card.billing_district,
        billing_state: card.billing_state,
        city: card.city,
        colors: card.colors,
        cpf: card.cpf,
        due_date: card.due_date,
        name_card_holder: card.name_card_holder,
        final_number: card.card_number.substring(12, 16),
        card_id: "",
        main: card.main,
    };

    try {
        const token = await stripe.tokens.create(param);
        const tokenId = token.id;
        console.log("xxxxxxxxxxx tokenId: ", tokenId);
        console.log("xxxxxxxxxxx token: ", token);

        const source = await stripe.customers.createSource(customerId, { source: tokenId });
        console.log("zzzzzzzzz source: ", source);
        // console.log("zzzzzzzzz card: ", JSON.stringify(source));          
        firebase.firestore().collection(`stripe_customers/${userUid}/payment_method`).add(source);

        await createCard(source.id);

    } catch (error) {
        console.log("xxxxxxxxxxx catch error: ", error.code);
        codeError = error.code;
    }

    console.log("xxxxxxxxxxx function end error: ", codeError);
    return codeError;

    async function createCard(cardId) {
        console.log("xxxxxxxxxxxxx createCard function", userCollection, userUid);
        console.log("xxxxxxxxxxxxx createCard function", newCard);

        var refCard = await firebase.firestore()
            .collection(userCollection)
            .doc(userUid)
            .collection('cards')
            .add(newCard);

        console.log("xxxxxxxxxxxxx createCard function", refCard.id);

        await refCard.update({
            "card_id": cardId,
            "id": refCard.id,
            "created_at": firebase.firestore.FieldValue.serverTimestamp(),
        });

        const cardsQuery = await user.ref
            .collection('cards')
            .where('status', '==', 'ACTIVE')
            .get();

        console.log("xxxxxxxxxxx cardsQuery: ", cardsQuery.docs.length, card.main);

        if (card.main == null || card.main == false) {
            if (cardsQuery.docs.isEmpty) {
                newCard.main = true;
            } else {
                var singleMainCard = true;

                for (var i = 0; i < cardsQuery.docs.length; i++) {
                    const cardDoc = cardsQuery.docs[i];
                    console.log("xxxxxxx for", cardDoc.get("main"));

                    if (cardDoc.get("main")) {
                        singleMainCard = false;
                        break;
                    }
                }
                console.log('%%%% dps do for', singleMainCard);
                newCard.main = singleMainCard;
            }
        } else {
            cardsQuery.docs.forEach(async (cardDocs) => {
                console.log('%%%% forEach', cardDocs.get("main"));

                if (cardDocs.get("main")) {
                    await cardDocs.ref.update({ 'main': false });
                }
            });
        }

        await refCard.update({
            "main": newCard.main,
            "status": "ACTIVE",
        });

        // definindo o cartão do stripe como o cartão padrão.
        if (card.main == true || newCard.main) {
            console.log("xxxxxxxxx if card.main == true: ", cardId);
            const customer = await stripe.customers.update(
                customerId,
                { invoice_settings: { default_payment_method: cardId } }
            );
        }

        console.log("newCard: ", newCard);
    }

}

// extorno de transação
exports.refundTransaction = functions.https.onCall(async (data, context) => {
    // let data = [transactionId, adminRefund];

    let transDoc = await firestore.collection('transactions').doc(data.transactionId).get();

    let patTransDoc = firestore.collection('patients').doc(transDoc.get('sender_id')).collection("transactions").doc(data.transactionId);

    let docTransDoc = firestore.collection('doctors').doc(transDoc.get('receiver_id')).collection("transactions").doc(data.transactionId);

    await transDoc.ref.update({ status: "PENDING_REFUND" });

    await docTransDoc.update({ status: "PENDING_REFUND" });

    await patTransDoc.update({ status: "PENDING_REFUND" });

    let now = firebase.firestore.FieldValue.serverTimestamp();

    let text = "";

    let appointmentId = transDoc.get("appointment_id");

    let appointmentIdSub = appointmentId.substring(appointmentId.length - 4, appointmentId.length).toUpperCase();

    if (data.adminRefund) {
        if (transDoc.get("type") == "GUARANTEE") {
            text = "O administrador reembolsou a caução de código " + appointmentIdSub;
        } else {
            text = "O administrador reembolsou o remanescente de código " + appointmentIdSub;
        }
    } else if (transDoc.get("type") == "GUARANTEE") {
        text = "O doutor reembolsou a caução de código " + appointmentIdSub;
    } else {
        text = "O doutor reembolsou o remanescente de código " + appointmentIdSub;
    }

    let notification = {
        created_at: now,
        dispatched_at: now,
        id: null,
        sender_id: transDoc.get('receiver_id'),
        receiver_id: transDoc.get('sender_id'),
        status: "SCHEDULED",
        text: text,
        type: "AUTO",
        viewed: false,
    };

    let receiver = firestore.collection("patients").doc(transDoc.get('sender_id'));

    let notUserRef = await receiver.collection('notifications').add(notification);
    await notUserRef.update({ id: notUserRef.id });

    // await receiver.update({new_notifications: firebase.firestore.FieldValue.increment(1)});

    let notRef = firestore.collection('notifications').doc(notUserRef.id);
    await notRef.set(notification);
    await notRef.update({ id: notUserRef.id });


    await onSendMessage(notUserRef.id, transDoc.get('sender_id'), "patients");

    if (data.adminRefund) {
        let notificationDoc = {
            created_at: now,
            dispatched_at: now,
            id: null,
            sender_id: transDoc.get('sender_id'),
            receiver_id: transDoc.get('receiver_id'),
            status: "SCHEDULED",
            text: text,
            type: "AUTO",
            viewed: false,
        };

        let receiver = firestore.collection("doctors").doc(transDoc.get('receiver_id'));

        let notUserRef = await receiver.collection('notifications').add(notificationDoc);
        await notUserRef.update({ id: notUserRef.id });

        // await receiver.update({new_notifications: firebase.firestore.FieldValue.increment(1)});

        let notRef = firestore.collection('notifications').doc(notUserRef.id);
        await notRef.set(notification);
        await notRef.update({ id: notUserRef.id });


        await onSendMessage(notUserRef.id, transDoc.get('receiver_id'), "doctors");
    }
});

// ------------------------------------ outras funções--------------------------------------------- //

// Sempre que uma postagem for editada, atualizar para todos os pacientes //
exports.updatePost = functions.firestore
    .document('posts/{postId}')
    .onUpdate(async (change, context) => {
        const feedDocAfter = change.after.data();
        const feedDocBefore = change.before.data();

        var statusAfter = feedDocAfter.status;
        var statusBefore = feedDocBefore.status;

        console.log("xxxxxxxxxxx updatePost ", feedDocAfter.dr_id);

        if (statusAfter != statusBefore && statusAfter == "REPORTED") { }
        else {
            var patientsQuery = await firestore.collection("patients").where("type", "==", "HOLDER").where('city', '==', feedDocBefore.city).get();

            patientsQuery.docs.forEach(async (patientDoc) => {
                var feedDoc = await patientDoc.ref.collection("feed").doc(feedDocBefore.id).get();

                console.log("xxxxxxxxxxxxxxxxxx forEach", feedDoc.exists);

                if (feedDoc.exists) {
                    await feedDoc.ref.update({
                        "bgr_image": feedDocAfter.bgr_image,
                        "text": feedDocAfter.text,
                        "like_count": feedDocAfter.like_count,
                        "status": feedDocAfter.status,
                    });

                }

            });

        }
    });

// --------------------------------------------------------------------------------- //

// Sempre que uma postagem for criada, disparar para todos os pacientes daquela cidade //
exports.shotPosts = functions.firestore.document('posts/{postId}').onCreate(async (snap, context) => {
    let now = firebase.firestore.FieldValue.serverTimestamp();

    console.log("xxxxxxxxxxxxxx shotPosts id " + snap.id);
    console.log("xxxxxxxxxxxxxx shotPosts data " + snap.get("city"));
    console.log("xxxxxxxxxxxxxx shotPosts data " + snap.get("state"));

    if (snap.get("city") != null) {

        var doctorDoc = await firestore.collection("doctors").doc(snap.get("dr_id")).get();

        var patientsQuery = await firestore.collection("patients").where("state", "==", snap.get("state")).where("type", "==", "HOLDER").get();

        console.log("xxxxxxxxxxxxxx postDoc " + snap.get("text"));
        console.log("xxxxxxxxxxxxxx postDoc Data " + JSON.stringify(snap.data()));

        patientsQuery.forEach(async (patientDoc) => {
            console.log("xxxxxxxxxxxxxx shotPosts forEach " + patientDoc.get("username"));

            if (patientDoc.get("city") == snap.get("city")) {
                await patientDoc.ref.collection("feed").doc(snap.id).set({
                    "dr_avatar": snap.get("dr_avatar"),
                    "dr_id": snap.get("dr_id"),
                    "dr_name": snap.get("dr_name"),
                    "dr_speciality": snap.get("dr_speciality"),
                    "bgr_image": snap.get("bgr_image"),
                    "text": snap.get("text"),
                    "like_count": 0,
                    "liked": false,
                    "status": "VISIBLE",
                    "created_at": firebase.firestore.FieldValue.serverTimestamp(),
                    "id": snap.id,
                    "city": snap.get("city"),
                });

                notificationModel = {
                    sender_id: snap.get("dr_id"),
                    created_at: now,
                    dispatched_at: now,
                    id: null,
                    receiver_id: patientDoc.id,
                    status: "SCHEDULED",
                    text: "Doutor(a) " + doctorDoc.get("username") + " acabou de postar uma publicação!",
                    type: "AUTO",
                    viewed: false,
                    image: snap.get("bgr_image"),
                };

                let notificationDoctor = await patientDoc.ref.collection("notifications").add(notificationModel);
                await notificationDoctor.update({ id: notificationDoctor.id });

                let notificationDoc = firestore.collection("notifications").doc(notificationDoctor.id);
                await notificationDoc.set(notificationModel);
                await notificationDoc.update({ id: notificationDoc.id });

                onSendNotification(notificationDoc.id, patientDoc.id, "patients", snap.get("bgr_image"));
            }
        });
    }
});

// --------------------------------------------------------------------------------- //

// Verificando se o horário do agendamento já passou, se sim, ocorre uma atualização do seu status //
// exports.scheduleTimer = functions.pubsub.schedule('every 15 minutes').onRun(async (context) => {
exports.appointmentTimer = functions.pubsub.schedule('every 2 minutes').onRun(async (context) => {
    var appointmentsQuery = await firestore.collection("appointments").orderBy('end_hour', "asc").get();

    appointmentsQuery.docs.forEach(async (appointmentDoc) => {
        console.log('############# id ' + appointmentDoc.id);

        var dateEndHour = appointmentDoc.get("end_hour");
        var timestampNow = moment(Date.now()).format();
        var endHour = moment(dateEndHour._seconds * 1000).format();

        console.log('############# timesTampNow ' + moment(Date.now()).format("YYYY-MM-DD HH:mm:ss"));
        console.log('############# endHour ' + moment(dateEndHour._seconds * 1000).format("YYYY-MM-DD HH:mm:ss"));

        var isBefore = moment(endHour).isBefore(timestampNow);
        console.log('############# isBefore isBefore ' + isBefore);

        if (isBefore) {
            console.log('xxxxxxxxxxx appointment status ' + appointmentDoc.data().status + ' xxxxxxxxxxxxxx');

            switch (appointmentDoc.data().status) {
                case 'SCHEDULED':
                    console.log('xxxxxxxxxxx appointmentd update to absent xxxxxxxxxxxxxx\n\n');

                    await appointmentDoc.ref.update({ status: "ABSENT" });

                    var patientDoc = await firestore.collection("patients").doc(appointmentDoc.get("patient_id")).get();

                    var patientAppointmentDoc = await patientDoc.ref.collection("appointments").doc(appointmentDoc.id).get();

                    await patientAppointmentDoc.ref.update({ status: "ABSENT" });

                    break;

                case 'FIT_REQUESTED':
                    console.log('xxxxxxxxxxx fit requested update to canceled xxxxxxxxxxxxxx\n\n');

                    await appointmentDoc.ref.update({ status: "CANCELED" });

                    var patientDoc = await firestore.collection("patients").doc(appointmentDoc.get("patient_id")).get();

                    var patientAppointmentDoc = await patientDoc.ref.collection("appointments").doc(appointmentDoc.id).get();

                    await patientAppointmentDoc.ref.update({ status: "CANCELED" });

                    break;

                case 'AWAITING':
                    console.log('xxxxxxxxxxx waiting update to awaiting_return || concluded xxxxxxxxxxxxxx\n\n');

                    var stringNewStatus = "AWAITING_RETURN";

                    var doctorDoc = await firestore.collection("doctors").doc(appointmentDoc.get("doctor_id")).get();

                    var returnDays = await doctorDoc.get("return_period");

                    console.log('xxxxxxxxxxx  returnDays: ' + returnDays);

                    var differenceDays = moment(timestampNow).diff(endHour, "days");

                    console.log('xxxxxxxxxxx  diferrenceDays: ' + differenceDays);

                    if (differenceDays >= returnDays) {
                        stringNewStatus = "CONCLUDED";
                    }

                    if (appointmentDoc.get('type') == 'return') {
                        stringNewStatus = "CONCLUDED";
                    }

                    await appointmentDoc.ref.update({ status: stringNewStatus });

                    var patientDoc = await firestore.collection("patients").doc(appointmentDoc.get("patient_id")).get();

                    var patientAppointmentDoc = await patientDoc.ref.collection("appointments").doc(appointmentDoc.id).get();

                    await patientAppointmentDoc.ref.update({ status: stringNewStatus });

                    break;

                case 'AWAITING_RETURN':
                    console.log('xxxxxxxxxxx waiting_return update to concluded xxxxxxxxxxxxxx\n\n');

                    var doctorDoc = await firestore.collection("doctors").doc(appointmentDoc.get("doctor_id")).get();

                    var returnDays = await doctorDoc.get("return_period");

                    console.log('xxxxxxxxxxx  returnDays: ' + returnDays);

                    var differenceDays = moment(timestampNow).diff(endHour, "days");

                    console.log('xxxxxxxxxxx  diferrenceDays: ' + differenceDays);

                    if (differenceDays > returnDays) {
                        await appointmentDoc.ref.update({ status: "CONCLUDED" });

                        var patientDoc = await firestore.collection("patients").doc(appointmentDoc.get("patient_id")).get();

                        var patientAppointmentDoc = await patientDoc.ref.collection("appointments").doc(appointmentDoc.id).get();

                        await patientAppointmentDoc.ref.update({ status: "CONCLUDED" });
                    }

                    break;

                default:
                    console.log('xxxxxxxxxxx default xxxxxxxxxxxxxx\n\n');

                    break;
            }
        }
    });
});

// --------------------------------------------------------------------------------- //

exports.sendAppointmentNotifications = functions.pubsub.schedule('every 2 minutes').onRun(async (context) => {
    let appointmentNotifications = await firestore.collection('notifications').where('status', '==', 'SCHEDULED').get();

    console.log('scheduleNotifications: ' + appointmentNotifications.docs.length);

    appointmentNotifications.docs.forEach(async (notification) => {
        let dateEndHour = notification.get("dispatched_at");
        let timestampNow = moment(Date.now()).format();
        let endHour = moment(dateEndHour._seconds * 1000).format();

        console.log('############# timesTampNow ' + moment(Date.now()).format("YYYY-MM-DD HH:mm:ss"));
        console.log('############# endHour ' + moment(dateEndHour._seconds * 1000).format("YYYY-MM-DD HH:mm:ss"));

        var isBefore = moment(endHour).isBefore(timestampNow);

        console.log("############# Is Berfore?? " + isBefore);

        console.log('##### receiver_id: ' + notification.get("receiver_id"));
        console.log('##### notification id: ' + notification.id);

        if (isBefore) {

            // notification.ref.update({date: firebase.firestore.FieldValue.serverTimestamp()});

            let _patient = firestore.collection('patients').doc(notification.get("receiver_id"));

            await _patient.get().then(async function (doc) {
                if (doc.exists) {
                    console.log("É paciente");
                    await notification.ref.update({ status: "SENDED" });
                    await notification.ref.update({ date: firebase.firestore.FieldValue.serverTimestamp() });
                    await doc.ref.collection('notifications').doc(notification.id).update(
                        {
                            status: "SENDED",
                            dispatched_at: firebase.firestore.FieldValue.serverTimestamp()
                        });

                    onSendNotification(notification.id, doc.id, "patients");
                } else {
                    console.log("não É paciente");
                    let _doctor = firestore.collection('doctors').doc(notification.get("receiver_id"));
                    await notification.ref.update({ status: "SENDED" });
                    await notification.ref.update({ dispatched_at: firebase.firestore.FieldValue.serverTimestamp() });
                    await _doctor.collection('notifications').doc(notification.id).update(
                        {
                            status: "SENDED",
                            dispatched_at: firebase.firestore.FieldValue.serverTimestamp()
                        });

                    onSendNotification(notification.id, _doctor.id, "doctors");
                }
            }).catch(function (error) {
                console.log("Error getting document:", error);
            });
        }
    });

});

// --------------------------------------------------------------------------------- //

exports.fitNotification = functions.https.onCall(async (data, context) => {

    console.log("senderId: " + data.senderId + " receiverId: " + data.receiverId + " receiverCollection: " + data.receiverCollection + " appointmentId: " + data.appointmentId);

    var sender = await firestore.collection("doctors").doc(data.senderId).get();

    let appointment = await firestore.collection("appointments").doc(data.appointmentId).get();

    var senderName = sender.get("username");

    var receiver = await firestore.collection("patients").doc(data.receiverId).get();

    var receiverName;

    if (appointment.get("dependent_id")) {
        console.log("É dependente");

        let dependent = await firestore.collection("patients").doc(appointment.get("dependent_id")).get();

        receiverName = dependent.get("username");
    } else {
        console.log("Não é dependente");
        receiverName = await receiver.get("username");
    }

    var notificationText = String("O doutor " + senderName + " está tentando encaixar o paciente " + receiverName + " em uma consulta!");

    let now = firebase.firestore.FieldValue.serverTimestamp();

    console.log("now " + now);

    notification = {
        created_at: now,
        dispatched_at: now,
        sender_id: data.senderId,
        receiver_id: data.receiverId,
        status: 'SCHEDULED',
        text: notificationText,
        type: 'AUTO',
        viewed: false,
        id: null,
    };

    var patientDoc = await firestore.collection(data.receiverCollection).doc(data.receiverId).get();

    let newNotificationDoc = await patientDoc.ref.collection("notifications").add(notification);

    await firestore.collection("notifications").doc(newNotificationDoc.id).set(notification);
    await firestore.collection("notifications").doc(newNotificationDoc.id).update({ id: newNotificationDoc.id });

    console.log("New Notification " + newNotificationDoc.id);

    await newNotificationDoc.update({
        id: newNotificationDoc.id
    });
    await onSendNotification(newNotificationDoc.id, data.receiverId, data.receiverCollection);
});

// --------------------------------------------------------------------------------- //

exports.answerNotification = functions.https.onCall(async (data, context) => {
    var sender = await firestore.collection("patients").doc(data.senderId).get();


    var senderName;

    var appointment = await firestore.collection("appointments").doc(data.appointmentId).get();

    if (appointment.get("dependent_id")) {
        console.log("É dependente");
        let dependent = await firestore.collection('patients').doc(appointment.get("dependent_id")).get();
        senderName = dependent.get("username");
    } else {
        console.log("Não é dependente");
        senderName = sender.get("username");
    }

    console.log("######### Sender Name: " + senderName);

    var receiver = firestore.collection("doctors").doc(data.receiverId);

    var confirmationText = "O paciente " + sender.get("username") + " aceitou seu encaixe!";
    var refusedText = "O paciente " + sender.get("username") + " recusou o encaixe!";

    let notificationText = data.confirm ? confirmationText : refusedText;

    let now = firebase.firestore.FieldValue.serverTimestamp();

    let confirmNotification = {
        created_at: now,
        dispatched_at: now,
        sender_id: data.senderId,
        receiver_id: data.receiverId,
        status: 'SCHEDULED',
        text: notificationText,
        type: 'AUTO',
        viewed: false,
        id: null,
    };

    let newNotificationDoc = await receiver.collection('notifications').add(confirmNotification);

    await firestore.collection("notifications").doc(newNotificationDoc.id).set(confirmNotification);
    await firestore.collection("notifications").doc(newNotificationDoc.id).update({ id: newNotificationDoc.id });
    await newNotificationDoc.update({
        id: newNotificationDoc.id,
    });
    await onSendNotification(newNotificationDoc.id, receiver.id, "doctors");



    if (data.confirm) {
        let reminderNotification = {
            created_at: now,
            dispatched_at: new firebase.firestore.Timestamp(data.seconds, data.nanoseconds),
            sender_id: data.receiverId,
            appointment_id: data.appointmentId,
            receiver_id: data.senderId,
            status: 'SCHEDULED',
            text: "O paciente " + senderName + " possui uma consulta às " + data.hourString + " horas!",
            type: 'AUTO',
            viewed: false,
            id: null,
        };

        // await sender.ref.update({new_notifications: firebase.firestore.FieldValue.increment(1)});
        let newRemindNotificationDoc = await sender.ref.collection('notifications').add(reminderNotification);
        await firestore.collection("notifications").doc(newRemindNotificationDoc.id).set(reminderNotification);
        await firestore.collection("notifications").doc(newRemindNotificationDoc.id).update({ id: newRemindNotificationDoc.id });
        await newRemindNotificationDoc.update({
            id: newRemindNotificationDoc.id
        });
    }
});

// --------------------------------------------------------------------------------- //

exports.confirmAppointment = functions.https.onCall(async (data, context) => {
    let now = firebase.firestore.FieldValue.serverTimestamp();
    let doctor = await firestore.collection('doctors').doc(data.senderId).get();
    let patient = await firestore.collection("patients").doc(data.receiverId).get();
    let patientName;

    var appointment = await firestore.collection("appointments").doc(data.appointmentId).get();

    if (appointment.get("dependent_id")) {
        console.log("É dependente");
        let dependent = await firestore.collection('patients').doc(appointment.get("dependent_id")).get();
        patientName = dependent.get("username");
    } else {
        console.log("Não é dependente");
        patientName = patient.get("username");
    }

    console.log("Patient name: " + patientName);

    let docNotification = {
        created_at: now,
        dispatched_at: now,
        id: null,
        sender_id: data.receiverId,
        receiver_id: data.senderId,
        status: "SCHEDULED",
        text: "Foi marcada uma consulta para o paciente  " + patientName + " no dia " + data.dateString + " às " + data.hourString + "!",
        type: "AUTO",
        viewed: false,
    };

    let reminderNotification = {
        created_at: now,
        dispatched_at: new firebase.firestore.Timestamp(data.hour.seconds, data.hour.nanoseconds),
        sender_id: data.senderId,
        appointment_id: data.appointmentId,
        receiver_id: data.receiverId,
        status: 'SCHEDULED',
        text: "O paciente " + patientName + " possui uma consulta às " + data.hourString + " horas!",
        type: 'AUTO',
        viewed: false,
        id: null,
    };

    let notificationDoc = await doctor.ref.collection("notifications").add(docNotification);
    await notificationDoc.update({ id: notificationDoc.id });

    let notificationDoctor = firestore.collection("notifications").doc(notificationDoc.id);
    await notificationDoctor.set(docNotification);
    await notificationDoctor.update({ id: notificationDoc.id });


    let notificationPat = await patient.ref.collection("notifications").add(reminderNotification);
    await notificationPat.update({ id: notificationPat.id });

    let notificationPatient = firestore.collection("notifications").doc(notificationPat.id);
    await notificationPatient.set(reminderNotification);
    await notificationPatient.update({ id: notificationPat.id });


    await onSendNotification(notificationDoc.id, doctor.id, "doctors");
});

// --------------------------------------------------------------------------------- //

exports.checkinNotification = functions.https.onCall(async (data, context) => {
    //let senderId, receiverId, text, endHour :{'seconds': seconds, 'nanoseconds': nanoseconds};
    let now = firebase.firestore.FieldValue.serverTimestamp();
    console.log("status " + data.status);
    let text = data.status == "AWAITING" ? "Checkin realizado!" : "Consulta cancelada pelo médico!";
    console.log("text " + text);

    // let sender = await firestore.collection('doctors').doc(data.senderId).get();


    let notification = {
        created_at: now,
        dispatched_at: now,
        id: null,
        sender_id: data.senderId,
        receiver_id: data.receiverId,
        status: "SCHEDULED",
        text: text,
        type: "AUTO",
        viewed: false,
    };
    var patientDoc = firestore.collection("patients").doc(data.receiverId);
    let notRef = await patientDoc.collection("notifications").add(notification);
    notRef.update({ id: notRef.id });
    // await firestore.collection("patients").doc(data.receiverId).update({new_notifications: firebase.firestore.FieldValue.increment(1)});
    await firestore.collection("notifications").doc(notRef.id).set(notification);
    await firestore.collection("notifications").doc(notRef.id).update({ id: notRef.id });


    console.log("Not Id: " + notRef.id);
    console.log("Rec Id: " + data.receiverId);

    await onSendNotification(notRef.id, data.receiverId, "patients");
});

// --------------------------------------------------------------------------------- //

exports.startAppointment = functions.https.onCall(async (data, context) => {
    let now = firebase.firestore.FieldValue.serverTimestamp();

    let tiemStamp = new firebase.firestore.Timestamp(data.seconds, data.nanoseconds);

    console.log("converted kkkk " + tiemStamp);
    console.log("dependent ? " + data.dependent);

    notification = {
        appointment_id: data.appointmentId,
        created_at: now,
        dispatched_at: tiemStamp,
        id: null,
        sender_id: data.senderId,
        receiver_id: data.receiverId,
        status: "SCHEDULED",
        text: data.dependent ? "Seu dependente tem uma consulta às " + data.hourString + " horas!" : "Você tem uma consulta às " + data.dateString + " horas!",
        type: "AUTO",
        viewed: false,
    };
    console.log("Text: " + notification.text + " date: " + data.date);
    var patientDoc = await firestore.collection("patients").doc(data.receiverId).get();
    let notRef = await patientDoc.ref.collection("notifications").add(notification);
    notRef.update({ id: notRef.id });
    await firestore.collection("notifications").doc(notRef.id).set(notification);
    await firestore.collection("notifications").doc(notRef.id).update({ id: notRef.id });
});

// --------------------------------------------------------------------------------- //

exports.returnNotification = functions.https.onCall(async (data, context) => {
    let now = firebase.firestore.FieldValue.serverTimestamp();

    let tiemStamp = new firebase.firestore.Timestamp(data.seconds, data.nanoseconds);

    console.log("converted kkkk " + tiemStamp);
    console.log("dependent ? " + data.dependent);

    notification = {
        appointment_id: data.appointmentId,
        created_at: now,
        dispatched_at: now,
        id: null,
        receiver_id: data.receiverId,
        status: "SCHEDULED",
        text: data.dependent ? "Marque o retorno para o seu dependente!" : "Marque o seu retorno!",
        type: "AUTO",
        viewed: false,
    };
    console.log("Text: " + notification.text);
    let notRef = await firestore.collection("patients").doc(data.receiverId).collection("notifications").add(notification);
    // await firestore.collection("patients").doc(data.receiverId).update({new_notifications: firebase.firestore.FieldValue.increment(1)});
    notRef.update({ id: notRef.id });
    await firestore.collection("notifications").doc(notRef.id).set(notification);
    await firestore.collection("notifications").doc(notRef.id).update({ id: notRef.id });
    await onSendNotification(notRef.id, data.receiverId, "patients");
});

// --------------------------------------------------------------------------------- //

exports.cancelNotification = functions.https.onCall(async (data, context) => {
    //let data = [doctorId, patientId, hourString, dateString];
    let now = firebase.firestore.FieldValue.serverTimestamp();
    let patRef = await firestore.collection('patients').doc(data.patientId).get();
    let patName = await patRef.data()['username'];

    let notification = {
        created_at: now,
        dispatched_at: now,
        id: null,
        sender_id: data.patientId,
        receiver_id: data.doctorId,
        status: "SCHEDULED",
        text: 'O paciente ' + patName + " cancelou a sua consulta marcada no dia " + data.dateString + " às " + data.hourString + " horas!",
        type: "AUTO",
        viewed: false,
    }

    let docNot = await firestore.collection("doctors").doc(data.doctorId).collection("notifications").add(notification);
    docNot.update({ id: docNot.id });
    // await firestore.collection("doctors").doc(data.doctorId).update({new_notifications: firebase.firestore.FieldValue.increment(1)});

    await firestore.collection("notifications").doc(docNot.id).set(notification);
    await firestore.collection("notifications").doc(docNot.id).update({ id: docNot.id });

    await onSendNotification(docNot.id, data.doctorId, "doctors");

    console.log('appointmentId: ' + data.appointmentId);
    let snapshot = await patRef.ref.collection('notifications').where('appointment_id', '==', data.appointmentId).get();

    console.log('snapshots: ' + snapshot.size);
    let olderNot = snapshot.docs[0];

    await olderNot.ref.update({ status: "CANCELED" });
    await firestore.collection('notifications').doc(olderNot.id).update({ status: "CANCELED" });

    console.log('snapshot id: ' + olderNot.id);

});

// --------------------------------------------------------------------------------- //

exports.messageNotification = functions.https.onCall(async (data, context) => {
    // let = [text, senderId, receiverId, receiverCollection]
    let now = firebase.firestore.FieldValue.serverTimestamp();

    let notification = {
        created_at: now,
        dispatched_at: now,
        id: null,
        sender_id: data.senderId,
        receiver_id: data.receiverId,
        status: "SCHEDULED",
        text: data.text,
        type: "MESSAGE",
        viewed: false,
    }

    let receiver = firestore.collection(data.receiverCollection).doc(data.receiverId);

    let notUserRef = await receiver.collection('notifications').add(notification);
    await notUserRef.update({ id: notUserRef.id });

    // await receiver.update({new_notifications: firebase.firestore.FieldValue.increment(1)});

    let notRef = firestore.collection('notifications').doc(notUserRef.id);
    await notRef.set(notification);
    await notRef.update({ id: notUserRef.id });

    await onSendMessage(notUserRef.id, data.receiverId, data.receiverCollection);
});

// --------------------------------------------------------------------------------- //

exports.evaluate = functions.https.onCall(async (data, context) => {
    // let = [text, senderId, receiverId, receiverCollection]
    let now = firebase.firestore.FieldValue.serverTimestamp();

    let notification = {
        created_at: now,
        dispatched_at: now,
        id: null,
        sender_id: data.senderId,
        receiver_id: data.receiverId,
        status: "SCHEDULED",
        text: data.text,
        type: "AUTO",
        viewed: false,
    }

    let receiver = firestore.collection(data.receiverCollection).doc(data.receiverId);

    let notUserRef = await receiver.collection('notifications').add(notification);
    await notUserRef.update({ id: notUserRef.id });

    // await receiver.update({new_notifications: firebase.firestore.FieldValue.increment(1)});

    let notRef = firestore.collection('notifications').doc(notUserRef.id);
    await notRef.set(notification);
    await notRef.update({ id: notUserRef.id });


    await onSendMessage(notUserRef.id, data.receiverId, data.receiverCollection);
});

// --------------------------------------------------------------------------------- //

exports.notifyUser = functions.https.onCall(async (data, context) => {
    // let = [text, senderId, receiverId, collection]

    let now = firebase.firestore.FieldValue.serverTimestamp();

    let notification = {
        created_at: now,
        dispatched_at: now,
        id: null,
        sender_id: data.senderId,
        receiver_id: data.receiverId,
        status: "SCHEDULED",
        text: data.text,
        type: "AUTO",
        viewed: false,
    }

    let receiver = firestore.collection(data.collection).doc(data.receiverId);

    let notUserRef = await receiver.collection('notifications').add(notification);
    await notUserRef.update({ id: notUserRef.id });

    // await receiver.update({new_notifications: firebase.firestore.FieldValue.increment(1)});

    let notRef = firestore.collection('notifications').doc(notUserRef.id);
    await notRef.set(notification);
    await notRef.update({ id: notUserRef.id });

    // if (data.postId) {
    //     await notRef.update({ post_id: notUserRef.id })
    //     await notUserRef.update({ post_id: notUserRef.id });
    // }


    await onSendMessage(notUserRef.id, data.receiverId, data.collection);
});

// --------------------------------------------------------------------------------- //

exports.supportNotification = functions.https.onCall(async (data, context) => {
    // let = [text, receiverId, collection]
    console.log("receiver ID: " + data.receiverId + "\nCollection " + data.collection + "\nText: " + data.text);
    let now = firebase.firestore.FieldValue.serverTimestamp();

    let notification = {
        created_at: now,
        dispatched_at: now,
        id: null,
        sender_id: null,
        receiver_id: data.receiverId,
        status: "SCHEDULED",
        text: data.text,
        type: "MESSAGE",
        viewed: false,
    }

    let notRef = await firestore.collection('notifications').add(notification);
    await notRef.update({ id: notRef.id })
    console.log("notification ID: " + notRef.id);
    let userNot = firestore.collection(data.collection).doc(data.receiverId).collection('notifications').doc(notRef.id);
    await userNot.set(notification);
    await userNot.update({ 'id': notRef.id });

    await firestore.collection(data.collection).doc(data.receiverId).update({ support_notifications: firebase.firestore.FieldValue.increment(1) })

    onSendMessage(notRef.id, data.receiverId, data.collection);
});

// --------------------------------------------------------------------------------- //

exports.notificationForAll = functions.https.onCall(async (data, context) => {
    // let = [senderId, text, receiverCollection]
    let now = firebase.firestore.FieldValue.serverTimestamp();

    let notification = {
        created_at: now,
        dispatched_at: now,
        id: null,
        sender_id: data.senderId,
        receiver_id: null,
        status: "SCHEDULED",
        text: data.text,
        type: "AUTO",
        viewed: false,
    }
    let receivers = await firestore.collection(data.receiverCollection).get();
    receivers.forEach(async (each) => {
        console.log('eachId: ' + each.id);
        let notRecRef = await each.ref.collection('notifications').add(notification);
        await notRecRef.update({
            id: notRecRef.id,
            receiver_id: each.id,
        });
        let notRef = firestore.collection('notifications').doc(notRecRef.id);
        let doc = await notRecRef.get();
        await notRef.set(doc.data());
        await onSendNotification(notRecRef.id, each.id, data.receiverCollection);
    });
});

// --------------------------------------------------------------------------------- //

exports.cancelSchedulesNotify = functions.https.onCall(async (data, context) => {
    console.log("xxxxxxxxxxxxxx cancelSchedulesNotify scheduleId: ", data.scheduleId, data.justification);

    var scheduleDoc = await firestore.collection('schedules').doc(data.scheduleId).get();

    console.log("xxxxxxxxxxxxxx cancelSchedulesNotify doctorId: ", scheduleDoc.get("doctor_id"));

    var doctorDoc = await firestore.collection("doctors").doc(scheduleDoc.get("doctor_id")).get();

    await doctorDoc.ref.collection("schedules").doc(data.scheduleId).update({ "status": "DELETED", "justification": data.justification });

    await scheduleDoc.ref.update({ "status": "DELETED", "justification": data.justification });

    let appointmentsQuery = await firestore.collection("appointments").where("schedule_id", "==", data.scheduleId).get();

    console.log("xxxxxxxxxxxxxx cancelSchedulesNotify length: ", appointmentsQuery.docs.length);

    let now = firebase.firestore.FieldValue.serverTimestamp();

    let notification = {
        created_at: now,
        dispatched_at: now,
        id: null,
        sender_id: scheduleDoc.get("doctor_id"),
        receiver_id: null,
        status: "SCHEDULED",
        text: data.justification,
        type: "AUTO",
        viewed: false,
    }

    appointmentsQuery.docs.forEach(async (appointmentDoc) => {
        console.log('xxxxxxxxxxxx forEach appointmentId: ', appointmentDoc.id);
        console.log('xxxxxxxxxxxx forEach status2: ', appointmentDoc.get('status'));
        if (appointmentDoc.get('status') == 'SCHEDULED' || appointmentDoc.get('status') == 'FIT_REQUESTED') {
            let receiver = await firestore.collection('patients').doc(appointmentDoc.get("patient_id")).get();

            receiver.ref.collection("appointments").doc(appointmentDoc.id).update({ "status": "CANCELED", "canceled_by_doctor": true, });

            await appointmentDoc.ref.update({ "status": "CANCELED", "canceled_by_doctor": true, });

            // let receiverData = receiver.data();

            let notRecRef = await receiver.ref.collection('notifications').add(notification);

            await notRecRef.update({
                id: notRecRef.id,
                receiver_id: receiver.id,
            });

            let notRef = firestore.collection('notifications').doc(notRecRef.id);

            await notRef.set((await notRecRef.get()).data());

            var tokenId = receiver.get('token_id');

            console.log("xxxxxxxxxxxx token_id ", receiver.get('token_id'));
            console.log("xxxxxxxxxxxx token_id2 ", receiver.get('token_id').length);
            console.log("xxxxxxxxxxxx notification_enbaled ", receiver.get('notification_disabled'));

            console.log("xxxxxxxxxxxx validação ", receiver.get('token_id') && receiver.get('notification_disabled'));

            if (tokenId.length != 0 && receiver.get('notification_disabled') == false) {
                // var infoQuery = await firestore.collection("info").get();
                // var infoDoc = infoQuery.docs[0];

                // console.log("logo_icon: " + infoDoc.get("logo_icon"));

                // var icon = infoDoc.get("logo_icon");

                console.log("receiver.get('text'): " + data.justification);


                const payload = {
                    notification: {
                        title: "EncontrarCuidado",
                        body: data.justification,
                        // icon: icon,
                    }
                }
                await messaging.sendToDevice(receiver.get('token_id'), payload)
                    .then(async function (res) {
                        await receiver.ref.update({ new_notifications: firebase.firestore.FieldValue.increment(1) });
                        console.log("Notifications2: " + receiver.get('notification_enbaled'));

                        await receiver.ref.collection('notifications').doc(notRef.id).update({ status: "SENDED" });
                        await notRef.update({ status: "SENDED" });
                        console.log("campos alterados com sucesso");
                    })
                    .catch(function (error) {
                        console.log("Erro ao enviar a mensagem: " + error);
                    });
            }
        }
    });
});

// --------------------------------------------------------------------------------- //

async function onSendMessage(notificationId, userId, userCollection) {
    let notificationDoc = await firestore.collection('notifications').doc(notificationId).get();
    let userDoc = await firestore.collection(userCollection).doc(userId).get();

    const payload = {
        notification: {
            title: userDoc.data().username,
            body: notificationDoc.data().text,
        }
    }

    let tokenList = [];

    await userDoc.ref.update({ new_notifications: firebase.firestore.FieldValue.increment(1) });
    console.log("secretaries increment: ", userCollection);

    if (userCollection == 'doctors') {
        var secretariesQuery = await userDoc.ref.collection("secretaries").where('status', '==', 'ACCEPTED').get();

        secretariesQuery.docs.forEach(async (secretaryDoc) => {
            console.log("secretaries forEach: ", secretaryDoc.id);

            var secretaryRef = await firestore.collection("doctors").doc(secretaryDoc.id).get();
            await secretaryRef.ref.update({ new_notifications: firebase.firestore.FieldValue.increment(1) });

            if (userDoc.get("notification_disabled") == true) {
                console.log("xxxxxxxxxxxxx if");
                if (secretaryRef.get("notification_disabled") == false) {
                    console.log("xxxxxxxxxxxxx secretaryRef.get(token_id) ", secretaryRef.get("token_id"));

                    tokenList.push(secretaryRef.get("token_id")[0]);
                    console.log("xxxxxxxxxxxxx push");

                }
            }
        });
    }

    console.log("ttttttttttttttttt notification enabled ", userDoc.get("notification_disabled"));

    console.log("ttttttttttttttttt tokenId tokenId ", tokenList.length, tokenList);

    if (tokenList.length != 0 || userDoc.get("notification_disabled") == false) {
        await messaging.sendToDevice(tokenList.length != 0 ? tokenList : userDoc.get("token_id"), payload)
            .then(async function (res) {
                console.log("Mensagem enviada com sucesso", res);


                await userDoc.ref.collection('notifications').doc(notificationId).update({ status: "SENDED" });
                await notificationDoc.ref.update({ status: "SENDED" });
                console.log("campos alterados com sucesso");
            })
            .catch(function (error) {
                console.log("Erro ao enviar a mensagem: " + error);
            });

        //   for(let token of userDoc.data().token_id){
        // }

    }

    // --------------------------------------------------------------------------------- //

}

async function onSendNotification(notificationId, userId, userCollection) {
    console.log("notificationId: " + notificationId);
    console.log("userId: " + userId);
    console.log("userCollection: " + userCollection);

    let notificationDoc = await firestore.collection('notifications').doc(notificationId).get();
    let userDoc = await firestore.collection(userCollection).doc(userId).get();
    let tokenList = [];

    const payload = {
        notification: {
            title: "EncontrarCuidado",
            body: notificationDoc.data().text,
            // image: image,
        }
    }

    await userDoc.ref.update({ new_notifications: firebase.firestore.FieldValue.increment(1) });

    if(userDoc.get("notification_disabled") == false) {
        tokenList = userDoc.get("token_id");
    } else {
        if (userCollection == 'doctors') {
            var secretariesQuery = await userDoc.ref.collection("secretaries").where('status', '==', 'ACCEPTED').get();
    
            console.log("ifffffff: " + secretariesQuery.docs.length);
            for (let index = 0; index < secretariesQuery.docs.length; index++) {
                const element = secretariesQuery.docs[index];
                var secretaryRef = await firestore.collection("doctors").doc(element.id).get();
                await secretaryRef.ref.update({ new_notifications: firebase.firestore.FieldValue.increment(1) });

                console.log("xxxxxxxxxxxxx if");
                if (secretaryRef.get("notification_disabled") == false) {
                    console.log("xxxxxxxxxxxxx secretaryRef.get(token_id) ", secretaryRef.get("token_id"));

                    tokenList.push(secretaryRef.get("token_id")[0]);
                    console.log("xxxxxxxxxxxxx push");

                }                
            }            
        }
    }

    console.log("ttttttttttttttttt notification disabled ", userDoc.get("notification_disabled"));

    console.log("ttttttttttttttttt tokenId tokenId ", tokenList.length, tokenList);

    if (tokenList.length != 0) {

        await messaging.sendToDevice(tokenList, payload)
            .then(async function (res) {
                console.log("Mensagem enviada com sucesso " + res);
                await userDoc.ref.collection('notifications').doc(notificationId).update({ status: "SENDED" });
                console.log("Notifications3: " + userDoc.data().new_notifications);
                await notificationDoc.ref.update({ status: "SENDED" });
                console.log("campos alterados com sucesso");
            })
            .catch(function (error) {
                console.log("Erro ao enviar a mensagem: " + error);
            });
    }
}