var Message = Composer.RelationalModel.extend({
	base_url: '/messages',

	body_key: 'data',

	relations: {
		persona: {
			type: Composer.HasOne,
			model: 'Persona'
		}
	},

	public_fields: [
		'id',
		'to',
		'from',
		'keys'
	],

	private_fields: [
		'notification',
		'subject',
		'body'
	],

	initialize: function()
	{
		this.sync = api_sync;
		return this.parent.apply(this, arguments);
	},

	init: function()
	{
		// keep the "created" timestamp updated (not that the ID changes, but w/e)
		this.bind('change:id', function() {
			var id = this.id(true);
			if(!id) return;
			var ts = parseInt(this.id().substr(0, 8), 16);
			if(!ts) return;
			var date = new Date(ts * 1000);
			this.set({created: date});
		}.bind(this), 'message:track_timestamp');
		this.trigger('change:id');
	}
});

var Messages = Composer.Collection.extend({
	model: 'Message',

	last_id: null,

	sortfn: function(a, b) { return a.id().localeCompare(b.id()); },

	init: function()
	{
		// track the last (greatest) ID of the synced messages
		this.bind('add', function(model) {
			this.last_id = this.last().id();
		}.bind(this), 'messages:track_last_id')
	},

	sync: function(options)
	{
		options || (options = {});
		turtl.user.get('personas').each(function(persona) {
			persona.get_messages({
				after: this.last_id,
				success: options.success,
				error: function(err, xhr) {
					barfr.barf('There was a problem grabbing messages from your persona '+persona.get('email')+': '+ err);
					if(options.error) options.error();
				}.bind(this)
			});
		}.bind(this));
	}
});

